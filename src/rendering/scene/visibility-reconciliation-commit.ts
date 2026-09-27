import type { RenderBand } from "../../domain/commands/render-bands";
import type { MountedSceneElement } from "./mounted-element";
import type { PendingReconciliation } from "./reconciliation-state";
import type { SceneDom } from "./scene-dom";
import type { MutableSceneInstrumentation, SceneStorePort } from "./types";
import { publishVisibilityRuns } from "./visibility-publication";

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
