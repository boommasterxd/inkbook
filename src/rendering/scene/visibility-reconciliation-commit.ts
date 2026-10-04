import type { RenderBand } from "../../domain/commands/render-bands";
import type { MountedSceneElement } from "./mounted-element";
import type { PendingReconciliation } from "./reconciliation-state";
import type { ReconciliationResult } from "./reconciliation-state";
import type { SceneDom } from "./scene-dom";
import type { MutableSceneInstrumentation, SceneStorePort } from "./types";
import {
  publishVisibilityRuns,
  removeVisibilityExits,
  scanVisibilityExits,
} from "./visibility-publication";
import { orderDeltaPublication } from "./visibility-delta-reconciliation";
import type { MountSlice, MountYieldReason } from "./mount-slice";

/** Orders only the remaining bounded cleanup list, preserving a partial element's cursor. */
function prepareVisibilityExitOrder(
  pending: PendingReconciliation,
  mounted: ReadonlyMap<string, MountedSceneElement>,
): boolean {
  if (pending.exitOrderPrepared || !pending.exitScanComplete) return false;
  pending.exitOrderPrepared = true;
  const partial = mounted.get(pending.exitIds[pending.exitIndex] ?? "");
  const start =
    pending.exitIndex + (partial !== undefined && partial.detachedPathCount > 0 ? 1 : 0);
  const prepared = pending.exitIds.length - start > 1;
  const unique = new Set(pending.exitIds.slice(start));
  if (start > pending.exitIndex && partial !== undefined) unique.delete(partial.id);
  const remaining = [...unique];
  remaining.sort((left, right) => {
    const a = mounted.get(left);
    const b = mounted.get(right);
    if (a === undefined) return b === undefined ? 0 : 1;
    if (b === undefined) return -1;
    if (a.band !== b.band) return a.band === "highlight" ? -1 : 1;
    return a.committedRank - b.committedRank;
  });
  for (let index = 0; index < remaining.length; index += 1) {
    pending.exitIds[start + index] = remaining[index]!;
  }
  pending.exitIds.length = start + remaining.length;
  return prepared;
}

/** Shares existing frame admission; native list sorting is one bounded indivisible step. */
export function removeOrderedVisibilityExits(
  pending: PendingReconciliation,
  options: Parameters<typeof removeVisibilityExits>[1],
  frame: Parameters<typeof removeVisibilityExits>[2],
): boolean {
  // Ownership-only exits need no physical sorting; admit their existing bounded cursor first.
  if (!pending.exitOrderPrepared && options.detachedCache?.retentionEnabled) {
    if (removeVisibilityExits(pending, options, { ...frame, retainedOnly: true })) return true;
  }
  if (
    !pending.exitOrderPrepared &&
    pending.exitScanComplete &&
    pending.exitIds.length - pending.exitIndex > 1 &&
    frame.now() >= frame.deadline
  )
    return false;
  const prepared = prepareVisibilityExitOrder(pending, options.mounted);
  if (prepared && frame.now() >= frame.deadline) return false;
  return removeVisibilityExits(pending, options, frame);
}

export function hasPendingVisibilityCleanup(pending: PendingReconciliation): boolean {
  return (
    pending.published || !pending.exitScanComplete || pending.exitIndex < pending.exitIds.length
  );
}

/** Records completion so remote waits park only after real exit bookkeeping has finished. */
export function collectPendingVisibilityExits(
  pending: PendingReconciliation,
  slice: MountSlice,
  instrumentation: MutableSceneInstrumentation,
  add: (id: string) => void,
): MountYieldReason | undefined {
  if (pending.exitScanComplete) return undefined;
  const reason = scanVisibilityExits(pending.exits, slice, instrumentation, add);
  if (reason === undefined) pending.exitScanComplete = true;
  return reason;
}

/** Alternates old mount cleanup with entrants after the first new publication. */
export function prepareVisibilityCleanup(
  pending: PendingReconciliation,
  slice: MountSlice,
  cleanup: {
    readonly collect: () => MountYieldReason | undefined;
    readonly remove: () => void;
  },
): MountYieldReason | undefined {
  if (!pending.cleanupFirst) return undefined;
  const initialBlock = slice.blockingReason();
  if (initialBlock !== undefined) return initialBlock;
  pending.cleanupFirst = false;
  const hasCollectedExits = pending.exitIndex < pending.exitIds.length;
  if (hasCollectedExits) {
    cleanup.remove();
    slice.record();
    const blocked = slice.blockingReason();
    if (blocked !== undefined) return blocked;
  }
  const blocked = cleanup.collect() ?? slice.blockingReason();
  if (blocked !== undefined) return blocked;
  if (!hasCollectedExits && pending.exitIndex < pending.exitIds.length) {
    cleanup.remove();
    slice.record();
  }
  return slice.blockingReason();
}

/** Publishes a target slice before using any remaining budget for obsolete mounts. */
export function publishPendingVisibility(
  pending: PendingReconciliation,
  newlyMountedIds: readonly string[],
  cleanup: {
    readonly collect: () => void;
    readonly remove: () => void;
    readonly canWork: () => boolean;
    readonly waitingForPreparation: boolean;
  },
): ReconciliationResult {
  if (pending.scanExits && newlyMountedIds.length > 0 && cleanup.canWork()) cleanup.collect();
  if (
    pending.delta !== undefined &&
    pending.exitIndex < pending.exitIds.length &&
    cleanup.canWork()
  )
    cleanup.remove();
  const committedVisibility = pending.targetPublished ? undefined : pending.visibility;
  pending.targetPublished ||= newlyMountedIds.length > 0;
  pending.cleanupFirst ||=
    hasPendingVisibilityCleanup(pending) &&
    (newlyMountedIds.length > 0 ||
      (cleanup.waitingForPreparation && hasPendingVisibilityCleanup(pending)));
  return {
    ...(newlyMountedIds.length === 0 || committedVisibility === undefined
      ? {}
      : { committedVisibility }),
    newlyMountedIds,
    pending: true,
  };
}

interface CommitOptions {
  readonly dom: SceneDom;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly mounted: Map<string, MountedSceneElement>;
  readonly orderDirty: Record<RenderBand, Set<string>>;
  readonly store: SceneStorePort;
}

/** Finalizes publication and advances the retained-order proof only after a full scan. */
export function commitVisibilityReconciliation(
  pending: PendingReconciliation,
  options: CommitOptions,
  epoch: number,
  output: string[],
): number {
  orderDeltaPublication(pending);
  publishVisibilityRuns({
    runs: pending.runs,
    count: pending.runCount,
    options,
    epoch,
    atomicPreserveRetainedOrder: pending.progressive ? undefined : pending.retainedOrderPreserved,
    output,
  });
  // Stable runs keep their existing proof. A changed physical order makes the next
  // run verify its retained anchors against the DOM once instead of visiting all IDs now.
  if (pending.delta === undefined && !pending.retainedOrderPreserved) epoch += 1;
  options.orderDirty.content.clear();
  options.orderDirty.highlight.clear();
  pending.order.release();
  return epoch;
}

export function completedVisibilityReconciliation(
  pending: PendingReconciliation,
  epoch: number,
  newlyMountedIds: readonly string[],
): ReconciliationResult {
  return {
    committedVisibility: pending.visibility,
    ...(pending.delta === undefined ? { orderProofEpoch: epoch } : {}),
    newlyMountedIds,
    pending: false,
  };
}
