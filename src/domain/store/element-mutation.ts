import { renderBandOf, type RenderBand } from "../commands/render-bands";
import type { InkElementV1 } from "../schema/public";
import type { UniformSpatialIndex } from "../spatial/index";

import {
  addConnectionReferences,
  removeConnectionReferences,
  assertResolvedConnections,
  isAnchorTarget,
  isConnectable,
  prepareConnectionDetachments,
  resolveConnections,
} from "./connections";
import { classifyReplacement, elementsEqual, hasConnections } from "./element-comparison";
import type { DocumentCapacity, DocumentCapacityPatch } from "./document-capacity";
import type { PreparedSpatialMutation } from "../spatial/mutation-preparation";
import { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import { validateTrustedRemovalOrder } from "./trusted-removal-order";
import { prepareMutationHistory } from "./mutation-history";
import {
  assignRecordVersions,
  createInitialRecord,
  createReplacementRecord,
  nextRecordVersion,
} from "./record-factory";
import { requireElementRecord } from "./record-access";
import {
  assertReplacementIdentity,
  assertValidRuntimeElement,
  assertValidReplacementElement,
} from "./replacement-planner";
import type {
  AppliedElementMutation,
  DeltaDomain,
  ElementMutation,
  ElementRank,
  ElementRecord,
  EndpointReference,
  StoreDelta,
  StoreSliceScheduler,
} from "./types";

export interface ElementMutationPlan {
  readonly applied: AppliedElementMutation;
  readonly bands: Record<RenderBand, string[]>;
  readonly capacityPatch: DocumentCapacityPatch;
  readonly delta: StoreDelta;
  readonly indexPatch: PreparedSpatialMutation;
  readonly ranks: Map<string, ElementRank>;
  readonly records: Map<string, ElementRecord | null>;
}

export interface MutationSource {
  readonly capacity: DocumentCapacity;
  readonly index: UniformSpatialIndex<string>;
  readonly bands: Readonly<Record<RenderBand, readonly string[]>>;
  readonly geometryVersion: number;
  readonly paintVersion: number;
  readonly ranks?: ReadonlyMap<string, ElementRank>;
  readonly records: ReadonlyMap<string, ElementRecord>;
  readonly reverseConnections: ReadonlyMap<string, readonly EndpointReference[]>;
}

export async function planElementMutation(
  source: MutationSource,
  requested: ElementMutation,
  sourceScheduler: StoreSliceScheduler,
  replay?: AppliedElementMutation,
  trustedRemoval = false,
): Promise<ElementMutationPlan | "cancelled" | null> {
  if (replay !== undefined && requested !== replay.forward && requested !== replay.reverse) {
    throw new RangeError("History replay must use a retained transition direction.");
  }
  const scheduler = new MutationPreparationScheduler(sourceScheduler);
  const sourceRanks = source.ranks ?? (await buildRanks(source.bands, scheduler));
  if (sourceRanks === "cancelled") return sourceRanks;
  const removeIds = await buildIdSet(requested.removeIds ?? [], scheduler);
  if (removeIds === "cancelled") return removeIds;
  const desired = await collectDesiredElements(
    source,
    requested.elements ?? [],
    removeIds,
    scheduler,
  );
  if (desired === "cancelled") return desired;
  const records = await buildRecords(source, desired, removeIds, scheduler);
  if (records === "cancelled") return records;
  const order = trustedRemoval
    ? await validateTrustedRemovalOrder(requested, source, sourceRanks, removeIds, scheduler)
    : await validateBands(requested.bands, source, records, sourceRanks, scheduler);
  if (order === "cancelled") return order;
  const { bands, ranks, dirtyBands } = order;
  const delta = await buildDelta(source, sourceRanks, records, ranks, dirtyBands, scheduler);
  if (delta === "cancelled") return delta;
  if (delta === null) return null;
  const derived = await buildDerivedState(source, records, delta, sourceScheduler);
  if (derived === "cancelled") return derived;
  const { capacityPatch, indexPatch } = derived;
  const applied = await prepareMutationHistory(
    { requested, source, desired, removeIds },
    scheduler,
    replay,
    trustedRemoval,
  );
  if (applied === "cancelled") return applied;
  return {
    applied,
    bands,
    capacityPatch,
    delta,
    indexPatch,
    ranks,
    records,
  };
}

async function collectDesiredElements(
  source: MutationSource,
  elements: readonly InkElementV1[],
  removeIds: ReadonlySet<string>,
  scheduler: MutationPreparationScheduler,
): Promise<Map<string, InkElementV1> | "cancelled"> {
  const desired = await collectConnectionDetachments(source, removeIds, scheduler);
  if (desired === "cancelled") return desired;
  for (const element of elements) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    if (desired.has(element.id) && !removeIds.has(element.id)) {
      throw new RangeError(`Duplicate mutation element ID: ${element.id}`);
    }
    if (removeIds.has(element.id))
      throw new RangeError(`Mutation cannot remove and set: ${element.id}`);
    const current = source.records.get(element.id);
    if (current === undefined) assertValidRuntimeElement(element);
    else {
      assertReplacementIdentity(current.element, element);
      assertValidReplacementElement(current.element, element);
    }
    desired.set(element.id, element);
  }
  const lookup = (id: string) =>
    removeIds.has(id) ? undefined : (desired.get(id) ?? source.records.get(id)?.element);
  for (const [id, element] of desired) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    if (isConnectable(element)) desired.set(id, resolveConnections(element, lookup));
  }
  return desired;
}

async function buildIdSet(
  ids: readonly string[],
  scheduler: MutationPreparationScheduler,
): Promise<Set<string> | "cancelled"> {
  const result = new Set<string>();
  for (const id of ids) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    result.add(id);
  }
  return result;
}

async function collectConnectionDetachments(
  source: MutationSource,
  removeIds: ReadonlySet<string>,
  scheduler: MutationPreparationScheduler,
): Promise<Map<string, InkElementV1> | "cancelled"> {
  const detached = new Map<string, InkElementV1>();
  for (const targetId of removeIds) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    const additions = prepareConnectionDetachments(
      new Set([targetId]),
      source.reverseConnections,
      (id) => detached.get(id) ?? requireElementRecord(source.records, id).element,
      () => undefined,
    );
    for (const [id, element] of additions) {
      if (!removeIds.has(id)) detached.set(id, element);
    }
  }
  return detached;
}

async function buildRecords(
  source: MutationSource,
  desired: ReadonlyMap<string, InkElementV1>,
  removeIds: ReadonlySet<string>,
  scheduler: MutationPreparationScheduler,
): Promise<Map<string, ElementRecord | null> | "cancelled"> {
  const records = new Map<string, ElementRecord | null>();
  for (const id of removeIds) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    requireElementRecord(source.records, id);
    records.set(id, null);
  }
  const versions = await mutationVersions(source, desired, scheduler);
  if (versions === "cancelled") return versions;
  const { geometryVersion, paintVersion } = versions;
  for (const [id, element] of desired) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    const current = source.records.get(id);
    if (current === undefined) {
      records.set(
        id,
        assignRecordVersions(createInitialRecord(element), geometryVersion, paintVersion),
      );
    } else {
      const updated = updatedRecord(current, element, geometryVersion, paintVersion);
      if (updated !== current) records.set(id, updated);
    }
  }
  return records;
}

async function mutationVersions(
  source: MutationSource,
  desired: ReadonlyMap<string, InkElementV1>,
  scheduler: MutationPreparationScheduler,
): Promise<{ geometryVersion: number; paintVersion: number } | "cancelled"> {
  let changesGeometry = false;
  let changesPaint = false;
  for (const [id, element] of desired) {
    const current = source.records.get(id);
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    if (current === undefined) {
      changesGeometry = true;
      changesPaint = true;
    } else {
      const domains = classifyReplacement(current.element, element);
      changesGeometry ||= domains.includes("geometry");
      changesPaint ||= domains.includes("paint");
    }
  }
  const geometryVersion = changesGeometry
    ? nextRecordVersion(source.geometryVersion, "geometryVersion")
    : source.geometryVersion;
  const paintVersion = changesPaint
    ? nextRecordVersion(source.paintVersion, "paintVersion")
    : source.paintVersion;
  return { geometryVersion, paintVersion };
}

function updatedRecord(
  current: ElementRecord,
  element: InkElementV1,
  geometryVersion: number,
  paintVersion: number,
): ElementRecord {
  if (elementsEqual(current.element, element)) return current;
  const domains = classifyReplacement(current.element, element);
  return createReplacementRecord(
    element,
    current,
    domains.includes("geometry") ? geometryVersion : current.geometryVersion,
    domains.includes("paint") ? paintVersion : current.paintVersion,
  );
}

async function validateBands(
  requested: Readonly<Record<RenderBand, readonly string[]>>,
  source: MutationSource,
  records: ReadonlyMap<string, ElementRecord | null>,
  sourceRanks: ReadonlyMap<string, ElementRank>,
  scheduler: MutationPreparationScheduler,
): Promise<
  | {
      bands: Record<RenderBand, string[]>;
      ranks: Map<string, ElementRank>;
      dirtyBands: Record<RenderBand, boolean>;
    }
  | "cancelled"
> {
  const seen = new Set<string>();
  const ranks = new Map<string, ElementRank>();
  const dirtyBands = {
    content: requested.content.length !== source.bands.content.length,
    highlight: requested.highlight.length !== source.bands.highlight.length,
  };
  let resultingSize = source.records.size;
  for (const [id, record] of records) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    if (record === null) resultingSize -= 1;
    else if (!source.records.has(id)) resultingSize += 1;
  }
  const bands: Record<RenderBand, string[]> = {
    content: new Array<string>(requested.content.length),
    highlight: new Array<string>(requested.highlight.length),
  };
  for (const band of ["highlight", "content"] as const) {
    for (let index = 0; index < requested[band].length; index += 1) {
      if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
      const id = requested[band][index]!;
      const record = records.has(id) ? records.get(id) : source.records.get(id);
      if (record == null || renderBandOf(record.element) !== band || seen.has(id)) {
        throw new RangeError(
          "Mutation band order must contain each resulting element exactly once.",
        );
      }
      seen.add(id);
      bands[band][index] = id;
      if (source.bands[band][index] !== id) dirtyBands[band] = true;
      const prior = sourceRanks.get(id);
      if (prior?.band !== band || prior.rank !== index) ranks.set(id, { band, rank: index });
    }
  }
  if (seen.size !== resultingSize) {
    throw new RangeError("Mutation band order must contain each resulting element exactly once.");
  }
  return { bands, ranks, dirtyBands };
}

async function buildRanks(
  bands: Readonly<Record<RenderBand, readonly string[]>>,
  scheduler: MutationPreparationScheduler,
): Promise<Map<string, ElementRank> | "cancelled"> {
  const ranks = new Map<string, ElementRank>();
  for (const band of ["highlight", "content"] as const) {
    for (let rank = 0; rank < bands[band].length; rank += 1) {
      if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
      ranks.set(bands[band][rank]!, { band, rank });
    }
  }
  return ranks;
}

async function buildDelta(
  source: MutationSource,
  sourceRanks: ReadonlyMap<string, ElementRank>,
  records: ReadonlyMap<string, ElementRecord | null>,
  ranks: ReadonlyMap<string, ElementRank>,
  dirtyBands: Readonly<Record<RenderBand, boolean>>,
  scheduler: MutationPreparationScheduler,
): Promise<StoreDelta | "cancelled" | null> {
  const changes: Array<StoreDelta["changes"][number]> = [];
  let geometryVersion = source.geometryVersion;
  let paintVersion = source.paintVersion;
  const affected = new Set<string>();
  for (const id of records.keys()) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    affected.add(id);
  }
  for (const id of ranks.keys()) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    affected.add(id);
  }
  for (const id of affected) {
    const before = source.records.get(id) ?? null;
    const after = records.has(id) ? (records.get(id) ?? null) : before;
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    const domains = mutationDomains(
      before,
      after,
      sourceRanks.get(id),
      ranks.get(id) ?? sourceRanks.get(id),
    );
    if (domains.length === 0) continue;
    if (after !== null) {
      geometryVersion = Math.max(geometryVersion, after.geometryVersion);
      paintVersion = Math.max(paintVersion, after.paintVersion);
    }
    changes.push(Object.freeze({ after, before, domains: Object.freeze(domains), id }));
  }
  if (changes.length === 0) return null;
  return Object.freeze({
    changes: Object.freeze(changes),
    dirtyBands: Object.freeze(dirtyBands),
    geometryVersion,
    paintVersion,
  });
}

function mutationDomains(
  before: ElementRecord | null,
  after: ElementRecord | null,
  previousRank: ElementRank | undefined,
  nextRank: ElementRank | undefined,
): DeltaDomain[] {
  if (before === null && after !== null) {
    const domains: DeltaDomain[] = ["geometry", "paint", "order", "visibility"];
    if (hasConnections(after.element)) domains.push("connection");
    return domains;
  }
  if (before !== null && after === null) {
    const domains: DeltaDomain[] = ["order", "visibility"];
    if (hasConnections(before.element) || isAnchorTarget(before.element))
      domains.push("connection");
    return domains;
  }
  if (before === null || after === null || nextRank === undefined) return [];
  const domains =
    before === after ? [] : classifyReplacement(before.element, after.element as InkElementV1);
  if (
    previousRank === undefined ||
    previousRank.band !== nextRank.band ||
    previousRank.rank !== nextRank.rank
  ) {
    domains.push("order");
  }
  return domains;
}

async function buildDerivedState(
  source: MutationSource,
  records: ReadonlyMap<string, ElementRecord | null>,
  delta: StoreDelta,
  scheduler: StoreSliceScheduler,
): Promise<
  { capacityPatch: DocumentCapacityPatch; indexPatch: PreparedSpatialMutation } | "cancelled"
> {
  const work = new MutationPreparationScheduler(scheduler);
  const previous: ElementRecord[] = [];
  const next: ElementRecord[] = [];
  const removed: string[] = [];
  const inserted: Array<{ id: string; bounds: ElementRecord["bounds"] }> = [];
  const lookup = (id: string) =>
    (records.has(id) ? records.get(id) : source.records.get(id))?.element;
  for (const change of delta.changes) {
    if (!(work.checkpoint() || (await work.resume()))) return "cancelled";
    if (change.before === change.after) continue;
    if (change.before !== null) previous.push(change.before);
    if (change.after !== null) {
      next.push(change.after);
      assertAffectedConnections(change.id, change.after, source, records, lookup);
    }
    if (change.before !== null && (change.after === null || change.domains.includes("geometry"))) {
      removed.push(change.id);
    }
    if (change.after !== null && (change.before === null || change.domains.includes("geometry"))) {
      inserted.push({ id: change.id, bounds: change.after.bounds });
    }
  }
  const capacity = await source.capacity.prepareTimeSliced(previous, next, scheduler);
  if (capacity === "cancelled" || scheduler.isCancelled?.()) return "cancelled";
  const indexPatch = await source.index.prepareMutationTimeSliced(removed, inserted, scheduler);
  if (indexPatch === "cancelled" || scheduler.isCancelled?.()) return "cancelled";
  return {
    capacityPatch: capacity.patch,
    indexPatch,
  };
}

function assertAffectedConnections(
  id: string,
  after: ElementRecord,
  source: MutationSource,
  records: ReadonlyMap<string, ElementRecord | null>,
  lookup: (id: string) => ElementRecord["element"] | undefined,
): void {
  assertResolvedConnections(after.element, lookup);
  for (const { linearId } of source.reverseConnections.get(id) ?? []) {
    const dependent = records.has(linearId) ? records.get(linearId) : source.records.get(linearId);
    if (dependent != null) assertResolvedConnections(dependent.element, lookup);
  }
}

export function commitMutationDerivedState(
  capacity: DocumentCapacity,
  reverseConnections: Map<string, EndpointReference[]>,
  plan: ElementMutationPlan,
): void {
  plan.indexPatch.commit();
  capacity.commit(plan.capacityPatch);
  for (const { before, after } of plan.delta.changes) {
    if (before === after) continue;
    if (before !== null) removeConnectionReferences(reverseConnections, before.element);
    if (after !== null) addConnectionReferences(reverseConnections, after.element);
  }
}
