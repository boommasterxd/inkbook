import { DEFAULT_HISTORY_BYTE_LIMIT } from "../commands/history";
import { renderBandOf } from "../commands/render-bands";
import { spatialCellMembershipCount, MAX_ELEMENT_CELLS } from "../spatial/index";
import { assertAcyclicConnections, assertResolvedConnections, connectionReferences, isAnchorTarget } from "./connections";
import type { CompactCommitState, CompactMutationPlan, CompactMutationSource } from "./compact-mutation-types";
import { freezeCompactMutation, validateCompactPlacements } from "./compact-mutation-order";
import { DeltaBuilder } from "./delta-builder";
import { classifyReplacement, hasConnections } from "./element-comparison";
import { checkpoint, collectDesiredElements, updatedRecord } from "./element-mutation";
import { mutableElement } from "./immutability";
import { elementMutationPayloadBytes, mutationStructurePayloadBytes } from "./mutation-payload";
import { assignRecordVersions, createInitialRecord, nextRecordVersion } from "./record-factory";
import { requireElementRecord } from "./record-access";
import { commitReverseConnectionPatches, type ReverseConnectionPatch } from "./replacement-reverse-patch";
import type { AppliedElementMutation, DeltaDomain, ElementMutation, ElementPlacement, ElementRecord, StoreDelta, StoreSliceScheduler } from "./types";

const MAX_COMPACT_RECORDS = 128;
const MAX_COMPACT_MEMBERSHIPS = 2048;
const MAX_COMPACT_REFERENCES = 512;
const MAX_COMPACT_PAYLOAD_BYTES = 1024 * 1024;

export async function planCompactMutation(
  source: CompactMutationSource,
  requested: ElementMutation,
  scheduler: StoreSliceScheduler,
): Promise<CompactMutationPlan | "fallback" | "cancelled" | null> {
  if (!withinInputBudget(source, requested)) return "fallback";
  const placements = validateCompactPlacements(source, requested);
  const removeIds = new Set(requested.removeIds ?? []);
  for (const id of removeIds) requireElementRecord(source.records, id);
  const desired = await collectDesiredElements(source, requested.elements ?? [], removeIds, scheduler);
  if (desired === "cancelled") return desired;
  if (desired.size + removeIds.size > MAX_COMPACT_RECORDS) return "fallback";
  const changed = buildCompactDelta(source, desired, removeIds);
  if (changed === "fallback" || changed === null) return changed;
  if (!(await checkpoint(scheduler))) return "cancelled";
  const reversePatches = prepareReversePatches(source, changed);
  if (reversePatches === "fallback") return reversePatches;
  const previous = changed.changes.flatMap(({ before }) => before === null ? [] : [before]);
  const next = changed.changes.flatMap(({ after }) => after === null ? [] : [after]);
  if (!withinRecordBudget([...previous, ...next])) return "fallback";
  const applied = compactTransition(source, changed, placements);
  const capacityPatch = source.capacity.prepare(previous, next);
  const insertions = source.index.prepareInsertions(changed.changes.filter(({ before }) => before === null).map(({ after, id }) => ({ bounds: after!.bounds, id })));
  if (!(await checkpoint(scheduler))) return "cancelled";
  return { applied, capacityPatch, delta: changed, insertions, kind: "compact", placements, reversePatches };
}

function withinInputBudget(source: CompactMutationSource, requested: ElementMutation): boolean {
  const removals = requested.removeIds ?? [];
  const elements = requested.elements ?? [];
  if (removals.length + elements.length > MAX_COMPACT_RECORDS) return false;
  // Mixed creation/removal uses the fully staged route, keeping insertion capacity validation atomic.
  if (removals.length > 0 && elements.some(({ id }) => !source.records.has(id))) return false;
  let references = 0;
  let bytes = 0;
  for (const id of removals) {
    references += source.reverseConnections.get(id)?.length ?? 0;
    const record = source.records.get(id);
    if (record !== undefined) bytes += elementMutationPayloadBytes(record.element);
  }
  for (const element of elements) bytes += elementMutationPayloadBytes(element);
  return references <= MAX_COMPACT_REFERENCES && bytes <= MAX_COMPACT_PAYLOAD_BYTES;
}

function buildCompactDelta(
  source: CompactMutationSource,
  desired: ReadonlyMap<string, import("../schema/public").InkElementV1>,
  removals: ReadonlySet<string>,
): StoreDelta | "fallback" | null {
  const builder = new DeltaBuilder();
  const creates = [...desired.keys()].some((id) => !source.records.has(id));
  const geometryVersion = creates ? nextRecordVersion(source.geometryVersion, "geometryVersion") : source.geometryVersion;
  const paintVersion = creates ? nextRecordVersion(source.paintVersion, "paintVersion") : source.paintVersion;
  const lookup = (id: string) => removals.has(id) ? undefined : desired.get(id) ?? source.records.get(id)?.element;
  assertAcyclicConnections(desired.keys(), lookup);
  for (const [id, element] of desired) {
    const before = source.records.get(id);
    assertResolvedConnections(element, lookup);
    if (before === undefined) {
      const after = assignRecordVersions(createInitialRecord(element), geometryVersion, paintVersion);
      builder.add(id, null, after, ["geometry", "paint", "order", "visibility", ...(hasConnections(element) ? ["connection" as const] : [])]);
      builder.dirtyBand(renderBandOf(element));
    } else {
      const domains = classifyReplacement(before.element, element);
      if (domains.includes("geometry") || domains.includes("paint")) return "fallback";
      if (domains.length > 0) builder.add(id, before, updatedRecord(before, element, geometryVersion, paintVersion), domains);
    }
  }
  for (const id of removals) {
    const before = requireElementRecord(source.records, id);
    const domains: DeltaDomain[] = ["order", "visibility"];
    if (hasConnections(before.element) || isAnchorTarget(before.element)) domains.push("connection");
    builder.add(id, before, null, domains);
  }
  return builder.build(geometryVersion, paintVersion);
}

function withinRecordBudget(records: readonly ElementRecord[]): boolean {
  let memberships = 0;
  let payload = 0;
  for (const record of records) {
    const count = spatialCellMembershipCount(record.bounds);
    // Overflow maximum maintenance scans its bounded set; defer those edits to staged adoption.
    if (count > MAX_ELEMENT_CELLS) return false;
    memberships += count;
    payload += elementMutationPayloadBytes(record.element);
  }
  return memberships <= MAX_COMPACT_MEMBERSHIPS && payload <= MAX_COMPACT_PAYLOAD_BYTES;
}

function prepareReversePatches(source: CompactMutationSource, delta: StoreDelta): readonly ReverseConnectionPatch[] | "fallback" {
  const changedIds = new Set(delta.changes.map(({ id }) => id));
  const additions = new Map<string, import("./types").EndpointReference[]>();
  const targets = new Set<string>();
  for (const { before, after } of delta.changes) {
    for (const { targetId } of before === null ? [] : connectionReferences(before.element)) targets.add(targetId);
    for (const { targetId, reference } of after === null ? [] : connectionReferences(after.element)) {
      targets.add(targetId);
      const list = additions.get(targetId) ?? [];
      list.push(Object.freeze(reference));
      additions.set(targetId, list);
    }
  }
  let visits = 0;
  const patches: ReverseConnectionPatch[] = [];
  for (const targetId of targets) {
    const current = source.reverseConnections.get(targetId) ?? [];
    visits += current.length + (additions.get(targetId)?.length ?? 0);
    if (visits > MAX_COMPACT_REFERENCES) return "fallback";
    const references = current.filter(({ linearId }) => !changedIds.has(linearId));
    references.push(...(additions.get(targetId) ?? []));
    patches.push({ references, targetId });
  }
  return patches;
}

function compactTransition(source: CompactMutationSource, delta: StoreDelta, placements: readonly ElementPlacement[]): AppliedElementMutation {
  const forwardElements = [];
  const reverseElements = [];
  const forwardRemove: string[] = [];
  const reverseRemove: string[] = [];
  const reversePlacements: ElementPlacement[] = [];
  for (const { id, before, after } of delta.changes) {
    if (after === null) forwardRemove.push(id);
    else if (before === null || forwardRemove.length === 0) forwardElements.push(mutableElement(after.element));
    if (before === null) reverseRemove.push(id);
    else {
      reverseElements.push(mutableElement(before.element));
      if (after === null) reversePlacements.push(Object.freeze({ id, ...source.getRank(id)! }));
    }
  }
  // Removal redo derives detachments; explicit replacements would collide with that derived state.
  const forward = freezeCompactMutation({ elements: forwardRemove.length > 0 ? [] : forwardElements, placements, removeIds: forwardRemove });
  const reverse = freezeCompactMutation({ elements: reverseElements, placements: reversePlacements, removeIds: reverseRemove });
  const payloadBytes = [forward, reverse].reduce((sum, mutation) => sum + mutationStructurePayloadBytes(mutation) + (mutation.elements ?? []).reduce((bytes, element) => bytes + elementMutationPayloadBytes(element), 0), 0);
  if (payloadBytes > DEFAULT_HISTORY_BYTE_LIMIT) throw new RangeError("Element mutation exceeds the retained history payload limit.");
  return Object.freeze({ forward, payloadBytes, reverse });
}

export function commitCompactMutation(state: CompactCommitState, plan: CompactMutationPlan): void {
  state.index.commitPreparedInsertions(plan.insertions);
  state.capacity.commit(plan.capacityPatch);
  for (const { id, after } of plan.delta.changes) {
    if (after === null) {
      state.records.delete(id);
      state.index.remove(id);
      state.ordering.remove(id);
    } else state.records.set(id, after);
  }
  for (const { id, band, rank } of plan.placements) state.ordering.insertAt(id, band, rank);
  commitReverseConnectionPatches(state.reverseConnections, plan.reversePatches);
}
