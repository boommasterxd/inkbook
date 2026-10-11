import type { RenderBand } from "../commands/render-bands";
import type { InkElementV1 } from "../schema/public";
import type { UniformSpatialIndex } from "../spatial/index";

import {
  addConnectionReferences,
  removeConnectionReferences,
  assertResolvedConnections,
  isAnchorTarget,
} from "./connections";
import { classifyReplacementSteps, elementsEqualSteps, hasConnections } from "./element-comparison";
import type { DocumentCapacity, DocumentCapacityPatch } from "./document-capacity";
import type { PreparedSpatialMutation } from "../spatial/mutation-preparation";
import { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import { buildIdSet, collectDesiredElements } from "./mutation-elements";
import {
  prepareMutationOrder,
  collectMutationAffectedIds,
  mutationOrderPreserved,
  type MutationOrder,
} from "./mutation-order";
import { prepareMutationHistory } from "./mutation-history";
import {
  ownedHistoryPayloadBytes,
  prepareOwnedMutationHistory,
  restoreOwnedRecordSteps,
  type OwnedMutationHistory,
  type OwnedMutationReplay,
} from "./owned-mutation-history";
import {
  assignRecordVersions,
  createOwnedInitialRecordSteps,
  createOwnedReplacementRecordSteps,
  nextRecordVersion,
} from "./record-factory";
import { requireElementRecord } from "./record-access";
import { resolveHistoryReplay } from "./owned-history-replay";
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
  readonly ownedHistory: OwnedMutationHistory | undefined;
  readonly requested: ElementMutation;
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
  ownedReplay?: OwnedMutationReplay,
): Promise<ElementMutationPlan | "cancelled" | null> {
  const scheduler = new MutationPreparationScheduler(sourceScheduler);
  const direction = requested;
  const resolved = resolveHistoryReplay(direction, replay, ownedReplay);
  const ownedRecords = resolved.records;
  requested = resolved.requested;
  const sourceRanks = source.ranks ?? (await buildRanks(source.bands, scheduler));
  if (sourceRanks === "cancelled") return sourceRanks;
  const removeIds = await buildIdSet(requested.removeIds ?? [], scheduler);
  if (removeIds === "cancelled") return removeIds;
  const collected = await collectDesiredElements(
    source,
    requested.elements ?? [],
    removeIds,
    scheduler,
    ownedRecords,
  );
  if (collected === "cancelled") return collected;
  const { desired, explicit } = collected;
  const records = await buildRecords(source, desired, removeIds, scheduler, ownedRecords);
  if (records === "cancelled") return records;
  const order = await prepareMutationOrder(source, requested, records, sourceRanks, scheduler, {
    trustedRemoval,
    ownedReplay,
    ownedRecords,
    removeIds,
  });
  if (order === "cancelled") return order;
  const { bands, ranks } = order;
  const delta = await buildDelta(source, sourceRanks, records, order, scheduler);
  if (delta === "cancelled") return delta;
  if (delta === null) return null;
  const derived = await buildDerivedState(source, records, delta, sourceScheduler);
  if (derived === "cancelled") return derived;
  const { capacityPatch, indexPatch } = derived;
  const ownedHistory = await prepareOwnedMutationHistory(
    delta,
    scheduler,
    ownedReplay?.history,
    replay !== undefined,
    order.relativeOrderPreserved,
  );
  if (ownedHistory === "cancelled") return ownedHistory;
  const applied = await prepareMutationHistory(
    {
      requested: historyDirection(requested, bands, explicit, removeIds, trustedRemoval),
      source,
      desired,
      removeIds,
      ownedPayloadBytes: ownedHistoryPayloadBytes(ownedHistory),
      retainedReplay: ownedReplay?.retainedMutation !== undefined,
    },
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
    ownedHistory,
    requested: direction,
  };
}

function historyDirection(
  requested: ElementMutation,
  bands: Record<RenderBand, string[]>,
  elements: readonly InkElementV1[],
  removeIds: ReadonlySet<string>,
  trustedRemoval: boolean,
): ElementMutation {
  return trustedRemoval ? requested : { bands, elements, removeIds: [...removeIds] };
}

async function buildRecords(
  source: MutationSource,
  desired: ReadonlyMap<string, InkElementV1>,
  removeIds: ReadonlySet<string>,
  scheduler: MutationPreparationScheduler,
  ownedRecords?: ReadonlyMap<string, ElementRecord>,
): Promise<Map<string, ElementRecord | null> | "cancelled"> {
  const records = new Map<string, ElementRecord | null>();
  for (const id of removeIds) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    requireElementRecord(source.records, id);
    records.set(id, null);
  }
  const versions = await mutationVersions(source, desired, scheduler);
  if (versions === "cancelled") return versions;
  for (const [id, element] of desired) {
    const current = source.records.get(id);
    const pendingRecord = scheduler.run(
      buildRecord(element, current, ownedRecords?.get(id), versions),
    );
    const record = pendingRecord instanceof Promise ? await pendingRecord : pendingRecord;
    if (record === "cancelled") return record;
    if (record !== current) records.set(id, record);
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
      const pendingDomains = scheduler.run(classifyReplacementSteps(current.element, element));
      const domains = pendingDomains instanceof Promise ? await pendingDomains : pendingDomains;
      if (domains === "cancelled") return domains;
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

function* buildRecord(
  element: InkElementV1,
  current: ElementRecord | undefined,
  owned: ElementRecord | undefined,
  versions: Readonly<{ geometryVersion: number; paintVersion: number }>,
): Generator<void, ElementRecord> {
  const restored = yield* restoreOwnedRecordSteps(element, current, owned, versions);
  if (restored !== undefined) return restored;
  if (current === undefined) {
    const initial = yield* createOwnedInitialRecordSteps(element);
    return assignRecordVersions(initial, versions.geometryVersion, versions.paintVersion);
  }
  if (yield* elementsEqualSteps(current.element, element)) return current;
  const domains = yield* classifyReplacementSteps(current.element, element);
  return yield* createOwnedReplacementRecordSteps(
    element,
    current,
    domains.includes("geometry") ? versions.geometryVersion : current.geometryVersion,
    domains.includes("paint") ? versions.paintVersion : current.paintVersion,
  );
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
  order: MutationOrder,
  scheduler: MutationPreparationScheduler,
): Promise<StoreDelta | "cancelled" | null> {
  const changes: Array<StoreDelta["changes"][number]> = [];
  let geometryVersion = source.geometryVersion;
  let paintVersion = source.paintVersion;
  const affected = await collectMutationAffectedIds(records, order, scheduler);
  if (affected === "cancelled") return affected;
  for (const id of affected) {
    const before = source.records.get(id) ?? null;
    const after = records.has(id) ? (records.get(id) ?? null) : before;
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    const pendingDomains = scheduler.run(
      mutationDomains(
        before,
        after,
        sourceRanks.get(id),
        order.ranks.get(id) ?? sourceRanks.get(id),
        mutationOrderPreserved(order, sourceRanks, id),
      ),
    );
    const domains = pendingDomains instanceof Promise ? await pendingDomains : pendingDomains;
    if (domains === "cancelled") return domains;
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
    dirtyBands: Object.freeze(order.dirtyBands),
    geometryVersion,
    paintVersion,
  });
}

function* mutationDomains(
  before: ElementRecord | null,
  after: ElementRecord | null,
  previousRank: ElementRank | undefined,
  nextRank: ElementRank | undefined,
  relativeOrderPreserved: boolean,
): Generator<void, DeltaDomain[]> {
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
    before === after
      ? []
      : yield* classifyReplacementSteps(before.element, after.element as InkElementV1);
  if (
    previousRank?.band !== nextRank.band ||
    (!relativeOrderPreserved && previousRank.rank !== nextRank.rank)
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
