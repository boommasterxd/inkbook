import type { RenderBand } from "../../domain/commands/render-bands";
import { mountedRootCount, type PendingMutationRun } from "./visibility-publication";
import { updatePreviewTransform, type MountedSceneElement } from "./mounted-element";
import type { MountSlice, MountYieldReason } from "./mount-slice";
import type { PreviewTransform } from "./scene-mount-preparation";
import type { PendingReconciliation } from "./reconciliation-state";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "./types";
import type { VisibilityResult } from "./visibility-state";

interface DeltaStageOptions {
  readonly instrumentation: MutableSceneInstrumentation;
  readonly mounted: ReadonlyMap<string, MountedSceneElement>;
  readonly store: SceneStorePort;
  readonly visibility: { contains(id: string): boolean };
  readonly stage: (
    pending: PendingReconciliation,
    record: SceneElementRecord,
    slice: MountSlice,
    previews: ReadonlyMap<string, PreviewTransform>,
  ) => MountedSceneElement | undefined;
  readonly run: (
    band: RenderBand,
    successor: MountedSceneElement | undefined,
  ) => PendingMutationRun;
}

/** Applies one small membership delta without visiting stable mounted nodes. */
export function stageVisibilityDelta(
  pending: PendingReconciliation,
  slice: MountSlice,
  previews: ReadonlyMap<string, PreviewTransform>,
  options: DeltaStageOptions,
): MountYieldReason | undefined {
  const delta = pending.delta;
  if (delta === undefined) return undefined;
  while (delta.index < delta.ids.length) {
    const id = delta.ids[delta.index]!;
    options.instrumentation.visibilityReconcileVisits += 1;
    if (options.mounted.has(id)) {
      delta.index += 1;
      continue;
    }
    const record = options.store.get(id);
    if (record === undefined || !options.visibility.contains(id)) {
      delta.index += 1;
      continue;
    }
    const reason = slice.blockingReason();
    if (reason !== undefined) return reason;
    if (!slice.canPublish) return "budget";
    const entry = pending.entrants.get(id) ?? options.stage(pending, record, slice, previews);
    if (entry === undefined) return "budget";
    const preview = previews.get(id);
    updatePreviewTransform(
      entry,
      preview?.transform ?? null,
      preview?.version ?? 0,
      preview?.strokeWidthScale ?? null,
      options.instrumentation,
    );
    if (!slice.claimPublicationNodes(mountedRootCount(entry))) return "budget";
    const run = options.run(
      record.band,
      deltaSuccessor(pending.visibility[record.band], record, options),
    );
    run.entries[0] = entry;
    run.entrants[0] = true;
    run.count = 1;
    pending.runCount += 1;
    slice.record();
    delta.index += 1;
  }
  return undefined;
}

function deltaSuccessor(
  band: VisibilityResult["content"],
  record: SceneElementRecord,
  options: DeltaStageOptions,
): MountedSceneElement | undefined {
  let low = 0;
  let high = band.count;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const current = options.store.get(band.ids[middle]!);
    options.instrumentation.visibilityReconcileVisits += 1;
    const earlier =
      current !== undefined &&
      (current.rank < record.rank ||
        (current.rank === record.rank && current.id.localeCompare(record.id) <= 0));
    if (earlier) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < band.count; index += 1) {
    const mounted = options.mounted.get(band.ids[index]!);
    options.instrumentation.visibilityReconcileVisits += 1;
    if (mounted !== undefined && mounted.detachedPathCount === 0) return mounted;
  }
  return undefined;
}

export function sortedVisibilityDelta(ids: readonly string[], store: SceneStorePort): string[] {
  return [...ids].sort((left, right) => {
    const a = store.get(left);
    const b = store.get(right);
    if (a === undefined || b === undefined) return a === undefined ? 1 : -1;
    if (a.band !== b.band) return a.band === "highlight" ? -1 : 1;
    return a.rank - b.rank || left.localeCompare(right);
  });
}
