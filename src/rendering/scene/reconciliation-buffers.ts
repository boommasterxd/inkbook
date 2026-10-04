import type { MountedSceneElement } from "./mounted-element";
import type { MutableSceneInstrumentation } from "./types";
import type { PendingMutationRun } from "./visibility-publication";
import type { PendingReconciliation, ReconciliationCursor } from "./reconciliation-state";
import { growVisibilityCapacity } from "./visibility-markers";

export function reconciliationMemoryUsage(
  pending: PendingReconciliation | undefined,
  publishedEntrants: number,
  deferredExits: number,
): number {
  return (
    (publishedEntrants + deferredExits) * 8 +
    (pending?.delta?.priority?.memoryUsage() ?? 0) +
    (pending?.delta?.order?.memoryUsage() ?? 0) +
    (pending?.delta?.publishedOrder?.memoryUsage() ?? 0) +
    (pending?.delta?.publicationPositions?.size ?? 0) * 32 +
    (pending?.order.memoryUsage() ?? 0)
  );
}

export function finishReconciliationRun(pending: PendingReconciliation): void {
  const run = pending.cursor.run;
  if (run === undefined) return;
  pending.cursor.successor = run.entries[run.count - 1] ?? pending.cursor.successor;
  pending.runCount += 1;
  pending.cursor.run = undefined;
}

export function recordReconciliationGrowth(
  current: number,
  required: number,
  instrumentation: MutableSceneInstrumentation,
): number {
  return growVisibilityCapacity(required, current, instrumentation);
}

export function prepareReconciliationRun(
  pending: PendingReconciliation | undefined,
  cursor: Pick<ReconciliationCursor, "band" | "successor">,
  instrumentation: MutableSceneInstrumentation,
): PendingMutationRun {
  if (pending === undefined) throw new Error("Cannot stage a visibility run without pending work.");
  let run = pending.runs[pending.runCount];
  if (run === undefined) {
    run = {
      band: cursor.band,
      capacity: 0,
      count: 0,
      entrants: [],
      entries: [],
      preserveRetainedOrder: pending.retainedOrderPreserved,
      successor: cursor.successor,
    };
    pending.runs[pending.runCount] = run;
    instrumentation.collectionAllocations += 1;
  } else {
    run.band = cursor.band;
    run.count = 0;
    run.preserveRetainedOrder = pending.retainedOrderPreserved;
    run.successor = cursor.successor;
  }
  return run;
}

export function resetReconciliationBuffers(state: {
  readonly preservePending: boolean;
  readonly entrants: Map<string, MountedSceneElement>;
  readonly exitIds: string[];
  readonly publishedEntrantIds: string[];
  readonly newlyMountedIds: string[];
  readonly runs: PendingMutationRun[];
  readonly exitCursor?: Pick<PendingReconciliation, "exitIndex"> | undefined;
}): void {
  const consumedExits = state.exitCursor?.exitIndex ?? 0;
  if (!state.preservePending) state.entrants.clear();
  if (!state.preservePending) state.exitIds.length = 0;
  else if (consumedExits > 0) state.exitIds.splice(0, consumedExits);
  if (!state.preservePending) state.publishedEntrantIds.length = 0;
  state.newlyMountedIds.length = 0;
  for (const run of state.runs) {
    for (let index = 0; index < run.count; index += 1) run.entries[index] = undefined;
    run.count = 0;
    run.successor = undefined;
  }
}
