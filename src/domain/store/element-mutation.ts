import { DEFAULT_HISTORY_BYTE_LIMIT } from "../commands/history";
import { renderBandOf, type RenderBand } from "../commands/render-bands";
import type { InkElementV1 } from "../schema/public";
import { UniformSpatialIndex } from "../spatial/index";

import {
  addConnectionReferences,
  assertResolvedConnections,
  isAnchorTarget,
  prepareConnectionDetachments,
  resolveConnections,
} from "./connections";
import { classifyReplacement, elementsEqual, hasConnections } from "./element-comparison";
import { DocumentCapacity } from "./document-capacity";
import { mutableElement } from "./immutability";
import { elementMutationPayloadBytes, mutationStructurePayloadBytes } from "./mutation-payload";
import {
  assignRecordVersions,
  createInitialRecord,
  createReplacementRecord,
  nextRecordVersion,
} from "./record-factory";
import { requireElementRecord } from "./record-access";
import {
  assertReplacementIdentity,
  assertValidElement,
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
  readonly capacity: DocumentCapacity;
  readonly delta: StoreDelta;
  readonly index: UniformSpatialIndex<string>;
  readonly overflowCount: number;
  readonly ranks: Map<string, ElementRank>;
  readonly records: Map<string, ElementRecord>;
  readonly reverseConnections: Map<string, EndpointReference[]>;
}

export interface MutationSource {
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
  scheduler: StoreSliceScheduler,
): Promise<ElementMutationPlan | "cancelled" | null> {
  const sourceRanks = source.ranks ?? (await buildRanks(source.bands, scheduler));
  if (sourceRanks === "cancelled") return sourceRanks;
  const removeIds = new Set(requested.removeIds ?? []);
  const desired = await collectDesiredElements(
    source,
    requested.elements ?? [],
    removeIds,
    scheduler,
  );
  if (desired === "cancelled") return desired;
  const records = await buildRecords(source, desired, removeIds, scheduler);
  if (records === "cancelled") return records;
  const bands = await validateBands(requested.bands, records, scheduler);
  if (bands === "cancelled") return bands;
  const ranks = await buildRanks(bands, scheduler);
  if (ranks === "cancelled") return ranks;
  const delta = await buildDelta(source, sourceRanks, records, ranks, bands, scheduler);
  if (delta === "cancelled") return delta;
  if (delta === null) return null;
  const derived = await buildDerivedState(records, scheduler);
  if (derived === "cancelled") return derived;
  const { capacity, index, reverseConnections } = derived;
  const forward = freezeMutation(requested);
  const reverse = await reverseMutation(source, desired, removeIds, scheduler);
  if (reverse === "cancelled") return reverse;
  const forwardBytes = await estimateMutationBytes(forward, scheduler);
  if (forwardBytes === "cancelled") return forwardBytes;
  const reverseBytes = await estimateMutationBytes(reverse, scheduler);
  if (reverseBytes === "cancelled") return reverseBytes;
  const payloadBytes = forwardBytes + reverseBytes;
  if (payloadBytes > DEFAULT_HISTORY_BYTE_LIMIT) {
    throw new RangeError("Element mutation exceeds the retained history payload limit.");
  }
  return {
    applied: Object.freeze({ forward, payloadBytes, reverse }),
    bands,
    capacity,
    delta,
    index,
    overflowCount: index.overflowCount,
    ranks,
    records,
    reverseConnections,
  };
}

async function collectDesiredElements(
  source: MutationSource,
  elements: readonly InkElementV1[],
  removeIds: ReadonlySet<string>,
  scheduler: StoreSliceScheduler,
): Promise<Map<string, InkElementV1> | "cancelled"> {
  const desired = prepareConnectionDetachments(
    removeIds,
    source.reverseConnections,
    (id) => requireElementRecord(source.records, id).element,
    () => undefined,
  );
  for (const element of elements) {
    if (!(await checkpoint(scheduler))) return "cancelled";
    if (desired.has(element.id) && !removeIds.has(element.id)) {
      throw new RangeError(`Duplicate mutation element ID: ${element.id}`);
    }
    if (removeIds.has(element.id))
      throw new RangeError(`Mutation cannot remove and set: ${element.id}`);
    const current = source.records.get(element.id);
    if (current === undefined) assertValidElement(element);
    else {
      assertReplacementIdentity(current.element, element);
      assertValidReplacementElement(current.element, element);
    }
    desired.set(element.id, element);
  }
  const lookup = (id: string) =>
    removeIds.has(id) ? undefined : (desired.get(id) ?? source.records.get(id)?.element);
  for (const [id, element] of desired) {
    if (!(await checkpoint(scheduler))) return "cancelled";
    desired.set(id, resolveConnections(element, lookup));
  }
  return desired;
}

async function buildRecords(
  source: MutationSource,
  desired: ReadonlyMap<string, InkElementV1>,
  removeIds: ReadonlySet<string>,
  scheduler: StoreSliceScheduler,
): Promise<Map<string, ElementRecord> | "cancelled"> {
  for (const id of removeIds) requireElementRecord(source.records, id);
  let changesGeometry = false;
  let changesPaint = false;
  for (const [id, element] of desired) {
    if (!(await checkpoint(scheduler))) return "cancelled";
    const current = source.records.get(id);
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
  const records = new Map(source.records);
  for (const id of removeIds) records.delete(id);
  for (const [id, element] of desired) {
    if (!(await checkpoint(scheduler))) return "cancelled";
    const current = source.records.get(id);
    if (current === undefined) {
      records.set(
        id,
        assignRecordVersions(createInitialRecord(element), geometryVersion, paintVersion),
      );
      continue;
    }
    if (elementsEqual(current.element, element)) continue;
    const domains = classifyReplacement(current.element, element);
    records.set(
      id,
      createReplacementRecord(
        element,
        current,
        domains.includes("geometry") ? geometryVersion : current.geometryVersion,
        domains.includes("paint") ? paintVersion : current.paintVersion,
      ),
    );
  }
  return records;
}

async function validateBands(
  requested: Readonly<Record<RenderBand, readonly string[]>>,
  records: ReadonlyMap<string, ElementRecord>,
  scheduler: StoreSliceScheduler,
): Promise<Record<RenderBand, string[]> | "cancelled"> {
  const seen = new Set<string>();
  const bands: Record<RenderBand, string[]> = { content: [], highlight: [] };
  for (const band of ["highlight", "content"] as const) {
    for (const id of requested[band]) {
      if (!(await checkpoint(scheduler))) return "cancelled";
      const record = records.get(id);
      if (record === undefined || renderBandOf(record.element) !== band || seen.has(id)) {
        throw new RangeError(
          "Mutation band order must contain each resulting element exactly once.",
        );
      }
      seen.add(id);
      bands[band].push(id);
    }
  }
  if (seen.size !== records.size) {
    throw new RangeError("Mutation band order must contain each resulting element exactly once.");
  }
  return bands;
}

async function buildRanks(
  bands: Readonly<Record<RenderBand, readonly string[]>>,
  scheduler: StoreSliceScheduler,
): Promise<Map<string, ElementRank> | "cancelled"> {
  const ranks = new Map<string, ElementRank>();
  for (const band of ["highlight", "content"] as const) {
    for (let rank = 0; rank < bands[band].length; rank += 1) {
      if (!(await checkpoint(scheduler))) return "cancelled";
      ranks.set(bands[band][rank]!, { band, rank });
    }
  }
  return ranks;
}

async function buildDelta(
  source: MutationSource,
  sourceRanks: ReadonlyMap<string, ElementRank>,
  records: ReadonlyMap<string, ElementRecord>,
  ranks: ReadonlyMap<string, ElementRank>,
  bands: Readonly<Record<RenderBand, readonly string[]>>,
  scheduler: StoreSliceScheduler,
): Promise<StoreDelta | "cancelled" | null> {
  const changes: Array<StoreDelta["changes"][number]> = [];
  let geometryVersion = source.geometryVersion;
  let paintVersion = source.paintVersion;
  const ids = new Set([...source.records.keys(), ...records.keys()]);
  for (const id of ids) {
    if (!(await checkpoint(scheduler))) return "cancelled";
    const before = source.records.get(id) ?? null;
    const after = records.get(id) ?? null;
    const domains = mutationDomains(before, after, sourceRanks.get(id), ranks.get(id));
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
    dirtyBands: Object.freeze({
      content: !sameOrder(source.bands.content, bands.content),
      highlight: !sameOrder(source.bands.highlight, bands.highlight),
    }),
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
  const domains = classifyReplacement(before.element, mutableElement(after.element));
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
  records: ReadonlyMap<string, ElementRecord>,
  scheduler: StoreSliceScheduler,
): Promise<
  | {
      capacity: DocumentCapacity;
      index: UniformSpatialIndex<string>;
      reverseConnections: Map<string, EndpointReference[]>;
    }
  | "cancelled"
> {
  const index = new UniformSpatialIndex<string>();
  const capacity = new DocumentCapacity();
  const reverseConnections = new Map<string, EndpointReference[]>();
  const lookup = (id: string) => records.get(id)?.element;
  for (const [id, record] of records) {
    if (!(await checkpoint(scheduler))) return "cancelled";
    index.insert(id, record.bounds);
    capacity.addInitial(record);
    assertResolvedConnections(record.element, lookup);
    addConnectionReferences(reverseConnections, record.element);
  }
  return { capacity, index, reverseConnections };
}

async function reverseMutation(
  source: MutationSource,
  desired: ReadonlyMap<string, InkElementV1>,
  removeIds: ReadonlySet<string>,
  scheduler: StoreSliceScheduler,
): Promise<ElementMutation | "cancelled"> {
  const elements: InkElementV1[] = [];
  const removedCreatedIds: string[] = [];
  for (const id of removeIds) {
    if (!(await checkpoint(scheduler))) return "cancelled";
    elements.push(mutableElement(requireElementRecord(source.records, id).element));
  }
  for (const id of desired.keys()) {
    if (!(await checkpoint(scheduler))) return "cancelled";
    const current = source.records.get(id);
    if (current === undefined) removedCreatedIds.push(id);
    else elements.push(mutableElement(current.element));
  }
  return freezeMutation({ bands: source.bands, elements, removeIds: removedCreatedIds });
}

function freezeMutation(mutation: ElementMutation): ElementMutation {
  return Object.freeze({
    bands: Object.freeze({
      content: Object.freeze([...mutation.bands.content]),
      highlight: Object.freeze([...mutation.bands.highlight]),
    }),
    elements: Object.freeze([...(mutation.elements ?? [])]),
    removeIds: Object.freeze([...(mutation.removeIds ?? [])]),
  });
}

async function estimateMutationBytes(
  mutation: ElementMutation,
  scheduler: StoreSliceScheduler,
): Promise<number | "cancelled"> {
  let bytes = mutationStructurePayloadBytes(mutation);
  for (const element of mutation.elements ?? []) {
    if (!(await checkpoint(scheduler))) return "cancelled";
    bytes += elementMutationPayloadBytes(element);
  }
  return bytes;
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function checkpoint(scheduler: StoreSliceScheduler): Promise<boolean> {
  if (scheduler.isCancelled?.() ?? false) return false;
  if (scheduler.shouldYield()) await scheduler.yieldControl();
  return !(scheduler.isCancelled?.() ?? false);
}
