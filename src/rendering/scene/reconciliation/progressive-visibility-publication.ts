import type { ScenePublicationBudget } from "./mount-slice";
import type {
  PendingReconciliation,
  SceneVisibilityReconcilerOptions,
} from "./reconciliation-state";
import { finishReconciliationRun } from "./reconciliation-buffers";
import { completeDeltaPublication, orderDeltaPublication } from "./visibility-delta-reconciliation";
import {
  mountedRootCount,
  publicationRootCount,
  publishVisibilityRuns,
  publishStableEntrantRun,
} from "./visibility-publication";
import type { PendingMutationRun } from "./visibility-publication";
import { SCENE_PUBLICATION_ELEMENTS_PER_UNIT } from "../constants";

interface ProgressivePublicationFrame {
  readonly deadline: number;
  readonly now: () => number;
  readonly epoch: number;
  readonly budget: ScenePublicationBudget;
  readonly output: string[];
  readonly published: string[];
}

/** Publishes complete elements under the original shared deadline.
 * Empty work returns undefined; a completed unit returns true, even without new IDs.
 */
export function createProgressiveVisibilityPublisher(
  pending: PendingReconciliation,
  options: SceneVisibilityReconcilerOptions,
  frame: ProgressivePublicationFrame,
): ((force?: boolean) => boolean | undefined) | undefined {
  let latePreparedAllowance = frame.budget.allowLatePreparedUnit === true;
  frame.budget.allowLatePreparedUnit = false;
  if (!pending.progressive) return undefined;
  frame.output.length = 0;
  return (force = true) => {
    let allowLatePreparedUnit = latePreparedAllowance;
    latePreparedAllowance = false;
    if (pending.cursor.run === undefined && pending.runCount === 0) return undefined;
    if (frame.now() >= frame.deadline && !allowLatePreparedUnit) return false;
    const elements = pendingPublicationElementCount(pending);
    if (!force && pending.delta !== undefined && elements < SCENE_PUBLICATION_ELEMENTS_PER_UNIT)
      return undefined;
    finishReconciliationRun(pending);
    orderDeltaPublication(pending);
    while (pending.runCount > 0) {
      const run = pending.runs[0]!;
      const { roots, reordered } = publicationRunWork(run);
      if (
        (frame.now() >= frame.deadline && !allowLatePreparedUnit) ||
        roots > frame.budget.remainingRoots
      )
        return false;
      const ids: string[] = [];
      if (pending.delta === undefined) {
        publishVisibilityRuns({
          runs: [run],
          count: 1,
          options,
          epoch: frame.epoch,
          output: ids,
          entrants: pending.entrants,
        });
      } else {
        ids.push(...publishStableEntrantRun(run, options, frame.epoch));
        for (let index = 0; index < run.count; index += 1) {
          const entry = run.entries[index];
          if (entry !== undefined) pending.entrants.delete(entry.id);
          run.entries[index] = undefined;
        }
        run.count = 0;
        run.successor = undefined;
      }
      frame.budget.remainingRoots -= roots;
      allowLatePreparedUnit = false;
      frame.output.push(...ids);
      frame.published.push(...ids);
      completeDeltaPublication(pending, ids, options);
      if (reordered) pending.order.invalidate();
      for (let index = 1; index < pending.runCount; index += 1)
        pending.runs[index - 1] = pending.runs[index]!;
      pending.runs[pending.runCount - 1] = run;
      pending.runCount -= 1;
    }
    return true;
  };
}

function pendingPublicationElementCount(pending: PendingReconciliation): number {
  let elements = pending.cursor.run?.count ?? 0;
  for (let runIndex = 0; runIndex < pending.runCount; runIndex += 1) {
    const run = pending.runs[runIndex];
    if (run === undefined) continue;
    elements += run.count;
  }
  return elements;
}

function publicationRunWork(run: PendingMutationRun): {
  roots: number;
  reordered: boolean;
} {
  let roots = 0;
  let reordered = false;
  for (let index = 0; index < run.count; index += 1) {
    const entry = run.entries[index];
    if (entry === undefined) continue;
    reordered ||= !run.entrants[index] && !run.preserveRetainedOrder;
    roots += run.entrants[index]
      ? publicationRootCount(entry)
      : run.preserveRetainedOrder
        ? 0
        : mountedRootCount(entry);
  }
  return { roots, reordered };
}
