import type { SpatialBounds } from "./bounds";
import { assertSpatialAggregateCapacity } from "./capacity";
import { cellMembershipCount } from "./cell-membership";
import type { CellRange, IndexedEntry, SpatialReplacement } from "./index-state";
import type { SpatialReplacementPreparationScheduler } from "./replacement-preparation";

// This selects the synchronous local patch; it does not impose a scheduler handoff.
export const MAX_ATOMIC_MUTATION_WORK = 1_024;

export interface PreparedSpatialMutation {
  readonly commit: () => void;
}

export interface StagedSpatialInsertion<Id> extends SpatialReplacement<Id> {
  readonly range: CellRange;
}

export interface StagedSpatialMutation<Id> {
  readonly removed: readonly IndexedEntry<Id>[];
  readonly removedIds: ReadonlySet<Id>;
  readonly inserted: readonly StagedSpatialInsertion<Id>[];
  readonly atomicWork: number;
  readonly commitWith: (apply: () => void) => PreparedSpatialMutation;
}

export interface MutationPorts<Id> {
  readonly get: (id: Id) => IndexedEntry<Id> | undefined;
  readonly generation: () => number;
  readonly heapEntries: number;
  readonly memberships: number;
  readonly overflow: number;
  readonly recordVersion: number;
  readonly range: (bounds: SpatialBounds) => CellRange;
  readonly commit: (
    removed: readonly IndexedEntry<Id>[],
    inserted: readonly StagedSpatialInsertion<Id>[],
  ) => void;
}

interface MutationState<Id> {
  readonly removedIds: Set<Id>;
  readonly removed: IndexedEntry<Id>[];
  readonly insertedIds: Set<Id>;
  readonly inserted: StagedSpatialInsertion<Id>[];
  memberships: number;
  overflow: number;
  atomicWork: number | undefined;
}

/** Validate the final aggregate before changing any live cells, including remove-and-insert swaps. */
export function prepareSpatialMutation<Id>(
  removals: readonly Id[],
  insertions: readonly SpatialReplacement<Id>[],
  ports: MutationPorts<Id>,
): PreparedSpatialMutation {
  const stage = createStage(ports);
  for (const id of removals) stageRemoval(id, stage, ports);
  for (const insertion of insertions) stageInsertion(insertion, stage, ports);
  return finishStage(stage, ports).commitWith(() => ports.commit(stage.removed, stage.inserted));
}

export async function stageSpatialMutationTimeSliced<Id>(
  removals: readonly Id[],
  insertions: readonly SpatialReplacement<Id>[],
  ports: MutationPorts<Id>,
  scheduler: SpatialReplacementPreparationScheduler,
): Promise<StagedSpatialMutation<Id> | "cancelled"> {
  const generation = ports.generation();
  const stage = createStage(ports, true);
  for (const id of removals) {
    const admission = spatialMutationCheckpoint(scheduler);
    if (
      admission === false ||
      (admission !== true && !(await admission)) ||
      generation !== ports.generation()
    )
      return "cancelled";
    stageRemoval(id, stage, ports);
  }
  for (const insertion of insertions) {
    const admission = spatialMutationCheckpoint(scheduler);
    if (
      admission === false ||
      (admission !== true && !(await admission)) ||
      generation !== ports.generation()
    )
      return "cancelled";
    stageInsertion(insertion, stage, ports);
  }
  const admission = spatialMutationCheckpoint(scheduler);
  if (
    admission === false ||
    (admission !== true && !(await admission)) ||
    generation !== ports.generation()
  )
    return "cancelled";
  return finishStage(stage, ports, generation);
}

function createStage<Id>(ports: MutationPorts<Id>, estimateAtomicWork = false): MutationState<Id> {
  return {
    removedIds: new Set(),
    removed: [],
    insertedIds: new Set(),
    inserted: [],
    memberships: ports.memberships,
    overflow: ports.overflow,
    atomicWork: estimateAtomicWork ? 0 : undefined,
  };
}

function stageRemoval<Id>(id: Id, state: MutationState<Id>, ports: MutationPorts<Id>): void {
  if (state.removedIds.has(id)) throw new RangeError("Duplicate spatial removal ID.");
  state.removedIds.add(id);
  const entry = ports.get(id);
  if (entry === undefined) throw new Error("Spatial index does not contain the ID.");
  state.removed.push(entry);
  const cells = entry.cellKeys.length / 2;
  state.memberships -= cells;
  state.overflow -= Number(entry.overflow);
  if (state.atomicWork !== undefined && state.atomicWork <= MAX_ATOMIC_MUTATION_WORK) {
    state.atomicWork += cells + (entry.overflow ? ports.overflow : 0);
  }
}

function stageInsertion<Id>(
  insertion: SpatialReplacement<Id>,
  state: MutationState<Id>,
  ports: MutationPorts<Id>,
): void {
  const { id } = insertion;
  if (state.insertedIds.has(id) || (!state.removedIds.has(id) && ports.get(id) !== undefined)) {
    throw new Error("Spatial index already contains the ID.");
  }
  state.insertedIds.add(id);
  const bounds = { ...insertion.bounds };
  const range = ports.range(bounds);
  state.inserted.push({ id, bounds, range });
  const cells = cellMembershipCount(range);
  state.memberships += cells;
  state.overflow += Number(range.overflow);
  // Once the shadow is required, later estimates cannot change the selected algorithm.
  if (state.atomicWork !== undefined && state.atomicWork <= MAX_ATOMIC_MUTATION_WORK) {
    state.atomicWork += cells + Math.ceil(Math.log2(ports.heapEntries + state.inserted.length + 1));
  }
}

function finishStage<Id>(
  state: MutationState<Id>,
  ports: MutationPorts<Id>,
  generation = ports.generation(),
): StagedSpatialMutation<Id> {
  assertSpatialAggregateCapacity(
    state.memberships,
    state.overflow,
    ports.recordVersion,
    state.inserted.length,
  );
  const hasChanges = state.removed.length !== 0 || state.inserted.length !== 0;
  let consumed = false;
  return {
    removed: state.removed,
    removedIds: state.removedIds,
    inserted: state.inserted,
    atomicWork: state.atomicWork ?? 0,
    commitWith: (apply) => ({
      commit: () => {
        if (consumed || generation !== ports.generation())
          throw new Error("Prepared spatial mutation is stale.");
        consumed = true;
        if (hasChanges) apply();
      },
    }),
  };
}

export function spatialMutationCheckpoint(
  scheduler: SpatialReplacementPreparationScheduler,
): boolean | Promise<boolean> {
  if (scheduler.isCancelled?.() ?? false) return false;
  if (!scheduler.shouldYield()) return true;
  return scheduler.yieldControl().then(() => !(scheduler.isCancelled?.() ?? false));
}
