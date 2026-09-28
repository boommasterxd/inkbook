import type { CellRange, IndexedEntry, SpatialReplacement } from "./index-state";
import {
  stageSpatialMutationTimeSliced,
  spatialMutationCheckpoint,
  type MutationPorts,
  type PreparedSpatialMutation,
  type StagedSpatialInsertion,
} from "./mutation-preparation";
import type { SpatialReplacementPreparationScheduler } from "./replacement-preparation";

// The shadow keeps immutable entry geometry, while rebuilding its own buckets and heap.
export interface SpatialMutationShadowPorts<Id, Shadow> {
  readonly mutation: MutationPorts<Id>;
  readonly entries: () => Iterable<IndexedEntry<Id>>;
  readonly createShadow: () => Shadow;
  readonly appendRetained: (shadow: Shadow, entry: IndexedEntry<Id>) => void;
  readonly appendInserted: (shadow: Shadow, insertion: StagedSpatialInsertion<Id>) => void;
  readonly adoptShadow: (shadow: Shadow, generation: number) => void;
}

// This bounds the synchronous local patch; it does not impose a scheduler handoff.
const MAX_ATOMIC_MUTATION_WORK = 1_024;

export async function prepareSpatialMutationTimeSliced<Id, Shadow>(
  removals: readonly Id[],
  insertions: readonly SpatialReplacement<Id>[],
  ports: SpatialMutationShadowPorts<Id, Shadow>,
  scheduler: SpatialReplacementPreparationScheduler,
): Promise<PreparedSpatialMutation | "cancelled"> {
  const generation = ports.mutation.generation();
  const stage = await stageSpatialMutationTimeSliced(
    removals,
    insertions,
    ports.mutation,
    scheduler,
  );
  if (
    stage === "cancelled" ||
    scheduler.isCancelled?.() ||
    generation !== ports.mutation.generation()
  )
    return "cancelled";
  if (stage.atomicWork <= MAX_ATOMIC_MUTATION_WORK) {
    return stage.commitWith(() => ports.mutation.commit(stage.removed, stage.inserted));
  }
  const shadow = ports.createShadow();
  for (const entry of ports.entries()) {
    const admission = shadowCheckpoint(scheduler, ports.mutation.generation, generation);
    if (admission === false || (admission !== true && !(await admission))) return "cancelled";
    if (!stage.removedIds.has(entry.id)) ports.appendRetained(shadow, entry);
  }
  for (const insertion of stage.inserted) {
    const admission = shadowCheckpoint(scheduler, ports.mutation.generation, generation);
    if (admission === false || (admission !== true && !(await admission))) return "cancelled";
    ports.appendInserted(shadow, insertion);
  }
  const admission = shadowCheckpoint(scheduler, ports.mutation.generation, generation);
  if (admission === false || (admission !== true && !(await admission))) return "cancelled";
  let pendingShadow: Shadow | undefined = shadow;
  return stage.commitWith(() => {
    const ready = pendingShadow!;
    pendingShadow = undefined;
    ports.adoptShadow(ready, generation);
  });
}

function shadowCheckpoint(
  scheduler: SpatialReplacementPreparationScheduler,
  currentGeneration: () => number,
  generation: number,
): boolean | Promise<boolean> {
  const admission = spatialMutationCheckpoint(scheduler);
  if (admission === false) return false;
  if (admission === true) return generation === currentGeneration();
  return admission.then((allowed) => allowed && generation === currentGeneration());
}

export function rangeFromEntry<Id>(entry: IndexedEntry<Id>): CellRange {
  if (entry.overflow) {
    return { maxCellX: 0, maxCellY: 0, minCellX: 0, minCellY: 0, overflow: true };
  }
  const keys = entry.cellKeys;
  return {
    minCellX: keys[0]!,
    minCellY: keys[1]!,
    maxCellX: keys[keys.length - 2]!,
    maxCellY: keys[keys.length - 1]!,
    overflow: false,
  };
}
