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
import { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import { elementMutationPayloadBytes } from "./mutation-payload";
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
  sourceScheduler: StoreSliceScheduler,
): Promise<ElementMutationPlan | "cancelled" | null> {
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
  const forward = await freezeMutation(requested, scheduler);
  if (forward === "cancelled") return forward;
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
  scheduler: MutationPreparationScheduler,
): Promise<Map<string, InkElementV1> | "cancelled"> {
  const desired = await collectConnectionDetachments(source, removeIds, scheduler);
  if (desired === "cancelled") return desired;
  for (const element of elements) {
    if (!(await scheduler.checkpoint(16))) return "cancelled";
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
    if (!(await scheduler.checkpoint(16))) return "cancelled";
    desired.set(id, resolveConnections(element, lookup));
  }
  return desired;
}

async function buildIdSet(
  ids: readonly string[],
  scheduler: MutationPreparationScheduler,
): Promise<Set<string> | "cancelled"> {
  const result = new Set<string>();
  for (const id of ids) {
    if (!(await scheduler.checkpoint())) return "cancelled";
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
    if (!(await scheduler.checkpoint(source.reverseConnections.has(targetId) ? 16 : 1)))
      return "cancelled";
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
): Promise<Map<string, ElementRecord> | "cancelled"> {
  for (const id of removeIds) {
    if (!(await scheduler.checkpoint())) return "cancelled";
    requireElementRecord(source.records, id);
  }
  let changesGeometry = false;
  let changesPaint = false;
  for (const [id, element] of desired) {
    const current = source.records.get(id);
    if (!(await scheduler.checkpoint(current === undefined ? 1 : 16))) return "cancelled";
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
  const records = new Map<string, ElementRecord>();
  for (const [id, current] of source.records) {
    if (!(await scheduler.checkpoint(desired.has(id) ? 16 : 1))) return "cancelled";
    if (removeIds.has(id)) continue;
    const element = desired.get(id);
    records.set(id, updatedRecord(current, element, geometryVersion, paintVersion));
  }
  for (const [id, element] of desired) {
    if (source.records.has(id)) continue;
    if (!(await scheduler.checkpoint(16))) return "cancelled";
    records.set(
      id,
      assignRecordVersions(createInitialRecord(element), geometryVersion, paintVersion),
    );
  }
  return records;
}

function updatedRecord(
  current: ElementRecord,
  element: InkElementV1 | undefined,
  geometryVersion: number,
  paintVersion: number,
): ElementRecord {
  if (element === undefined || elementsEqual(current.element, element)) return current;
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
  records: ReadonlyMap<string, ElementRecord>,
  scheduler: MutationPreparationScheduler,
): Promise<Record<RenderBand, string[]> | "cancelled"> {
  const seen = new Set<string>();
  const bands: Record<RenderBand, string[]> = {
    content: new Array<string>(requested.content.length),
    highlight: new Array<string>(requested.highlight.length),
  };
  for (const band of ["highlight", "content"] as const) {
    for (let index = 0; index < requested[band].length; index += 1) {
      if (!(await scheduler.checkpoint())) return "cancelled";
      const id = requested[band][index]!;
      const record = records.get(id);
      if (record === undefined || renderBandOf(record.element) !== band || seen.has(id)) {
        throw new RangeError(
          "Mutation band order must contain each resulting element exactly once.",
        );
      }
      seen.add(id);
      bands[band][index] = id;
    }
  }
  if (seen.size !== records.size) {
    throw new RangeError("Mutation band order must contain each resulting element exactly once.");
  }
  return bands;
}

async function buildRanks(
  bands: Readonly<Record<RenderBand, readonly string[]>>,
  scheduler: MutationPreparationScheduler,
): Promise<Map<string, ElementRank> | "cancelled"> {
  const ranks = new Map<string, ElementRank>();
  for (const band of ["highlight", "content"] as const) {
    for (let rank = 0; rank < bands[band].length; rank += 1) {
      if (!(await scheduler.checkpoint())) return "cancelled";
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
  scheduler: MutationPreparationScheduler,
): Promise<StoreDelta | "cancelled" | null> {
  const changes: Array<StoreDelta["changes"][number]> = [];
  let geometryVersion = source.geometryVersion;
  let paintVersion = source.paintVersion;
  for (const id of source.records.keys()) {
    const before = source.records.get(id) ?? null;
    const after = records.get(id) ?? null;
    if (
      !(await scheduler.checkpoint(before === after || before === null || after === null ? 1 : 16))
    )
      return "cancelled";
    const domains = mutationDomains(before, after, sourceRanks.get(id), ranks.get(id));
    if (domains.length === 0) continue;
    if (after !== null) {
      geometryVersion = Math.max(geometryVersion, after.geometryVersion);
      paintVersion = Math.max(paintVersion, after.paintVersion);
    }
    changes.push(Object.freeze({ after, before, domains: Object.freeze(domains), id }));
  }
  for (const [id, after] of records) {
    if (source.records.has(id)) continue;
    if (!(await scheduler.checkpoint())) return "cancelled";
    const domains = mutationDomains(null, after, undefined, ranks.get(id));
    geometryVersion = Math.max(geometryVersion, after.geometryVersion);
    paintVersion = Math.max(paintVersion, after.paintVersion);
    changes.push(Object.freeze({ after, before: null, domains: Object.freeze(domains), id }));
  }
  if (changes.length === 0) return null;
  const contentOrderChanged = await orderChanged(source.bands.content, bands.content, scheduler);
  if (contentOrderChanged === "cancelled") return contentOrderChanged;
  const highlightOrderChanged = await orderChanged(
    source.bands.highlight,
    bands.highlight,
    scheduler,
  );
  if (highlightOrderChanged === "cancelled") return highlightOrderChanged;
  return Object.freeze({
    changes: Object.freeze(changes),
    dirtyBands: Object.freeze({
      content: contentOrderChanged,
      highlight: highlightOrderChanged,
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
  const domains =
    before === after ? [] : classifyReplacement(before.element, mutableElement(after.element));
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
  scheduler: MutationPreparationScheduler,
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
    if (!(await scheduler.checkpoint(16))) return "cancelled";
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
  scheduler: MutationPreparationScheduler,
): Promise<ElementMutation | "cancelled"> {
  const elements: InkElementV1[] = [];
  const removedCreatedIds: string[] = [];
  for (const id of removeIds) {
    if (!(await scheduler.checkpoint(16))) return "cancelled";
    elements.push(mutableElement(requireElementRecord(source.records, id).element));
  }
  for (const id of desired.keys()) {
    const current = source.records.get(id);
    if (!(await scheduler.checkpoint(current === undefined ? 1 : 16))) return "cancelled";
    if (current === undefined) removedCreatedIds.push(id);
    else elements.push(mutableElement(current.element));
  }
  return freezeMutation({ bands: source.bands, elements, removeIds: removedCreatedIds }, scheduler);
}

async function freezeMutation(
  mutation: ElementMutation,
  scheduler: MutationPreparationScheduler,
): Promise<ElementMutation | "cancelled"> {
  const content = await copyFrozen(mutation.bands.content, scheduler);
  if (content === "cancelled") return content;
  const highlight = await copyFrozen(mutation.bands.highlight, scheduler);
  if (highlight === "cancelled") return highlight;
  const elements = await copyFrozen(mutation.elements ?? [], scheduler);
  if (elements === "cancelled") return elements;
  const removeIds = await copyFrozen(mutation.removeIds ?? [], scheduler);
  if (removeIds === "cancelled") return removeIds;
  return Object.freeze({
    bands: Object.freeze({ content, highlight }),
    elements,
    removeIds,
  });
}

async function copyFrozen<T>(
  values: readonly T[],
  scheduler: MutationPreparationScheduler,
): Promise<readonly T[] | "cancelled"> {
  const copy = new Array<T>(values.length);
  for (let index = 0; index < values.length; index += 1) {
    if (!(await scheduler.checkpoint())) return "cancelled";
    copy[index] = values[index]!;
  }
  return Object.freeze(copy);
}

async function estimateMutationBytes(
  mutation: ElementMutation,
  scheduler: MutationPreparationScheduler,
): Promise<number | "cancelled"> {
  let bytes = (mutation.bands.content.length + mutation.bands.highlight.length) * 80;
  for (const id of mutation.removeIds ?? []) {
    if (!(await scheduler.checkpoint())) return "cancelled";
    bytes += id.length * 2;
  }
  for (const element of mutation.elements ?? []) {
    if (!(await scheduler.checkpoint())) return "cancelled";
    bytes += elementMutationPayloadBytes(element);
  }
  return bytes;
}

async function orderChanged(
  left: readonly string[],
  right: readonly string[],
  scheduler: MutationPreparationScheduler,
): Promise<boolean | "cancelled"> {
  if (left.length !== right.length) return true;
  for (let index = 0; index < left.length; index += 1) {
    if (!(await scheduler.checkpoint())) return "cancelled";
    if (left[index] !== right[index]) return true;
  }
  return false;
}
