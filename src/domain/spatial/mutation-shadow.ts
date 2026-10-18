import type { IndexedEntry, SpatialReplacement } from "./index-state";
import { bottomHeapEntry, heapifyBottomAt, type BottomHeapEntry } from "./max-bottom-heap";
import {
  stageSpatialMutationTimeSliced,
  spatialMutationCheckpoint,
  MAX_ATOMIC_MUTATION_WORK,
  type MutationPorts,
  type PreparedSpatialMutation,
  type StagedSpatialInsertion,
  type StagedSpatialMutation,
} from "./mutation-preparation";
import type { SpatialReplacementPreparationScheduler } from "./replacement-preparation";

// The shadow keeps immutable entry geometry, while rebuilding its own buckets and heap.
export interface SpatialMutationShadowPorts<Id, Shadow> {
  readonly mutation: MutationPorts<Id>;
  readonly entries: Pick<ReadonlyMap<Id, IndexedEntry<Id>>, "size" | "values">;
  readonly prepareRemoval: (
    stage: StagedSpatialMutation<Id>,
    scheduler: SpatialReplacementPreparationScheduler,
    generation: number,
  ) => Promise<PreparedSpatialMutation | "cancelled">;
  readonly createShadow: () => Shadow;
  readonly appendRetained: (shadow: Shadow, entry: IndexedEntry<Id>) => IndexedEntry<Id>;
  readonly appendInserted: (
    shadow: Shadow,
    insertion: StagedSpatialInsertion<Id>,
  ) => IndexedEntry<Id>;
  readonly adoptShadow: (
    shadow: Shadow,
    generation: number,
    extentHeap: BottomHeapEntry<Id>[],
  ) => void;
}

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
    const commit = ports.mutation.commit;
    return stage.commitWith(() => commit(stage.removed, stage.inserted));
  }
  if (stage.inserted.length === 0 && stage.removedIds.size < ports.entries.size) {
    return ports.prepareRemoval(stage, scheduler, generation);
  }
  const prepared = await buildShadow(stage, ports, scheduler, generation);
  if (prepared === "cancelled") return prepared;
  const admission = shadowCheckpoint(scheduler, ports.mutation.generation, generation);
  if (admission === false || (admission !== true && !(await admission))) return "cancelled";
  let pendingShadow: Shadow | undefined = prepared.shadow;
  let pendingExtentHeap: BottomHeapEntry<Id>[] | undefined = prepared.extentHeap;
  const adoptShadow = ports.adoptShadow;
  return stage.commitWith(() => {
    const ready = pendingShadow!;
    const extentHeap = pendingExtentHeap!;
    pendingShadow = undefined;
    pendingExtentHeap = undefined;
    // Publish all instance-owned state together; old cursors observe the new generation.
    adoptShadow(ready, generation, extentHeap);
  });
}

async function buildShadow<Id, Shadow>(
  stage: StagedSpatialMutation<Id>,
  ports: SpatialMutationShadowPorts<Id, Shadow>,
  scheduler: SpatialReplacementPreparationScheduler,
  generation: number,
): Promise<{ shadow: Shadow; extentHeap: BottomHeapEntry<Id>[] } | "cancelled"> {
  const shadow = ports.createShadow();
  const extentHeap: BottomHeapEntry<Id>[] = [];
  // Validated distinct removals cover every old entry, including a complete replacement.
  const retainedEntries =
    stage.removedIds.size === ports.entries.size ? [] : ports.entries.values();
  for (const entry of retainedEntries) {
    const admission = shadowCheckpoint(scheduler, ports.mutation.generation, generation);
    if (admission === false || (admission !== true && !(await admission))) return "cancelled";
    if (!stage.removedIds.has(entry.id)) {
      const retained = ports.appendRetained(shadow, entry);
      if (!retained.overflow) extentHeap.push(bottomHeapEntry(retained));
    }
  }
  for (const insertion of stage.inserted) {
    const admission = shadowCheckpoint(scheduler, ports.mutation.generation, generation);
    if (admission === false || (admission !== true && !(await admission))) return "cancelled";
    const inserted = ports.appendInserted(shadow, insertion);
    if (!inserted.overflow) extentHeap.push(bottomHeapEntry(inserted));
  }
  for (let index = Math.floor(extentHeap.length / 2) - 1; index >= 0; index -= 1) {
    const admission = shadowCheckpoint(scheduler, ports.mutation.generation, generation);
    if (admission === false || (admission !== true && !(await admission))) return "cancelled";
    heapifyBottomAt(extentHeap, index);
  }
  return { shadow, extentHeap };
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
