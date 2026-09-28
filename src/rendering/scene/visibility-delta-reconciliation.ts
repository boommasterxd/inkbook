import type { RenderBand } from "../../domain/commands/render-bands";
import { mountedRootCount, type PendingMutationRun } from "./visibility-publication";
import { updatePreviewTransform, type MountedSceneElement } from "./mounted-element";
import type { MountSlice, MountYieldReason } from "./mount-slice";
import type { PreviewTransform } from "./scene-mount-preparation";
import type { PendingReconciliation } from "./reconciliation-state";
import type { VisibilityDelta } from "./visibility-types";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "./types";

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

export function prepareVisibilityDelta(
  delta: VisibilityDelta,
): NonNullable<PendingReconciliation["delta"]> {
  return { ids: delta.entered.slice(), index: 0, successors: {}, search: undefined };
}

export function invalidateDeltaSuccessor(pending: PendingReconciliation, band: RenderBand): void {
  if (pending.delta === undefined) return;
  delete pending.delta.successors[band];
  pending.delta.search = undefined;
}

/** Applies membership deltas without visiting stable mounted nodes. */
export function stageVisibilityDelta(
  pending: PendingReconciliation,
  slice: MountSlice,
  previews: ReadonlyMap<string, PreviewTransform>,
  options: DeltaStageOptions,
): MountYieldReason | undefined {
  const delta = pending.delta;
  if (delta === undefined) return undefined;
  while (delta.index < delta.ids.length) {
    const blocked = slice.blockingReason();
    if (blocked !== undefined) return blocked;
    const id = delta.ids[delta.index]!;
    options.instrumentation.visibilityReconcileVisits += 1;
    if (options.mounted.has(id)) {
      slice.record();
      delta.index += 1;
      continue;
    }
    const record = options.store.get(id);
    if (record === undefined || !options.visibility.contains(id)) {
      slice.record();
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
    const successor = deltaSuccessor(pending, record, slice, options);
    if (successor === "deadline") return "deadline";
    if (!slice.claimPublicationNodes(mountedRootCount(entry))) return "budget";
    const run = options.run(record.band, successor);
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
  pending: PendingReconciliation,
  record: SceneElementRecord,
  slice: MountSlice,
  options: DeltaStageOptions,
): MountedSceneElement | "deadline" | undefined {
  const band = pending.visibility[record.band];
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
  const cached = pending.delta?.successors[record.band];
  if (cached !== undefined && low <= cached.index) return cached.entry;
  const search = pending.delta?.search;
  const start = search?.id === record.id ? Math.max(low, search.index) : low;
  for (let index = start; index < band.count; index += 1) {
    if (slice.blockingReason() !== undefined) {
      if (pending.delta !== undefined) pending.delta.search = { id: record.id, index };
      return "deadline";
    }
    const mounted = options.mounted.get(band.ids[index]!);
    options.instrumentation.visibilityReconcileVisits += 1;
    slice.record();
    if (mounted !== undefined && mounted.detachedPathCount === 0) {
      if (pending.delta !== undefined) {
        pending.delta.successors[record.band] = { index, entry: mounted };
        pending.delta.search = undefined;
      }
      return mounted;
    }
  }
  if (pending.delta !== undefined) {
    pending.delta.successors[record.band] = { index: band.count, entry: undefined };
    pending.delta.search = undefined;
  }
  return undefined;
}
