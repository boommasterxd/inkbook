import type { MountedSceneElement } from "./mounted-element";
import type { MountSlice, MountYieldReason } from "./mount-slice";
import type {
  PendingReconciliation,
  SceneVisibilityReconcilerOptions,
} from "./reconciliation-state";
import type { SceneElementRecord } from "./types";
import { firstMountedSuccessor } from "./visibility-order";
import { publicationRootCount, type PendingMutationRun } from "./visibility-publication";
import { invalidateDeltaSuccessor } from "./visibility-delta-reconciliation";

interface PromotionOptions extends SceneVisibilityReconcilerOptions {
  readonly waiting: () => boolean;
  readonly stage: (record: SceneElementRecord) => MountedSceneElement | undefined;
  readonly run: (
    entry: MountedSceneElement,
    successor: MountedSceneElement | undefined,
  ) => PendingMutationRun;
}

/** Gives an explicitly hit element an early chance without blocking cache-ready entrants. */
export function stagePromotedVisibility(
  id: string | undefined,
  pending: PendingReconciliation,
  slice: MountSlice,
  options: PromotionOptions,
): { readonly id?: string; readonly reason?: MountYieldReason } {
  if (id === undefined) return {};
  const record = options.store.get(id);
  if (record === undefined || !options.visibility.contains(id)) return {};
  if (pending.progressive && !slice.canPublish) return { id, reason: "budget" };
  const entry = pending.entrants.get(id) ?? options.stage(record);
  slice.record();
  if (entry === undefined) return options.waiting() ? { id } : { id, reason: "budget" };
  if (!pending.progressive) return {};
  if (!slice.claimPublicationNodes(publicationRootCount(entry))) return { id, reason: "budget" };
  const successor =
    options.detachedCache === undefined
      ? firstMountedSuccessor(pending.visibility[entry.band], id, options.mounted)
      : options.detachedCache.successor(record);
  const run = options.run(entry, successor);
  run.entries[0] = entry;
  run.entrants[0] = true;
  run.count = 1;
  pending.runCount += 1;
  invalidateDeltaSuccessor(pending, entry.band);
  return { reason: "budget" };
}
