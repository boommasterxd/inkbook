import type { RenderBand } from "../../domain/commands/render-bands";
import { publicationRootCount, type PendingMutationRun } from "./visibility-publication";
import type { DetachedSceneElementCache } from "./detached-element-cache";
import { updatePreviewTransform, type MountedSceneElement } from "./mounted-element";
import type { MountSlice, MountYieldReason } from "./mount-slice";
import type { PreviewTransform } from "./scene-mount-preparation";
import type { PendingReconciliation } from "./reconciliation-state";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "./types";
import { VisibleMountOrder } from "./visible-mount-order";

/** Retains scanned empty gaps while indexing only newly published roots within them. */
export function completeDeltaPublication(
  pending: PendingReconciliation,
  ids: readonly string[],
  options: Pick<DeltaStageOptions, "mounted" | "store" | "instrumentation" | "detachedCache">,
): void {
  const delta = pending.delta;
  if (delta === undefined || ids.length === 0) return;
  for (const id of ids) {
    delta.priority?.release(id);
    if (options.detachedCache !== undefined) continue;
    if (delta.order !== undefined) {
      delta.order.add(id);
      continue;
    }
    const entry = options.mounted.get(id);
    if (entry === undefined) continue;
    delta.publishedOrder ??= new VisibleMountOrder(
      pending.visibility,
      options.mounted,
      options.instrumentation,
      0,
    );
    const position = delta.publicationPositions?.get(id);
    delta.publishedOrder.addPublished(
      entry.band,
      position ?? successorStart(entry, pending, options) - 1,
    );
    delta.publicationPositions?.delete(id);
  }
  delta.search = undefined;
}

interface DeltaStageOptions {
  readonly detachedCache?: DetachedSceneElementCache;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly mounted: ReadonlyMap<string, MountedSceneElement>;
  readonly store: SceneStorePort;
  readonly visibility: { contains(id: string): boolean };
  readonly waiting: () => boolean;
  readonly prepareDeferred: () => string | undefined;
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

export function invalidateDeltaSuccessor(pending: PendingReconciliation, band: RenderBand): void {
  if (pending.delta === undefined) return;
  delete pending.delta.successors[band];
  pending.delta.search = undefined;
}

/** Spatial preparation is repacked into ascending SVG rank within each retained gap. */
export function orderDeltaPublication(pending: PendingReconciliation): void {
  if (pending.delta === undefined || pending.runCount < 2) return;
  const runs = pending.runs.slice(0, pending.runCount);
  runs.sort((left, right) => {
    if (left.band !== right.band) return left.band === "highlight" ? -1 : 1;
    const a = left.entries[0]!;
    const b = right.entries[0]!;
    return b.rank - a.rank || b.id.localeCompare(a.id);
  });
  let count = 0;
  let previous: PendingMutationRun | undefined;
  for (const run of runs) {
    if (previous?.band === run.band && previous.successor === run.successor) {
      previous.entries[previous.count] = run.entries[0];
      previous.entrants[previous.count] = true;
      previous.count += 1;
      previous.capacity = Math.max(previous.capacity, previous.count);
      run.entries[0] = undefined;
      run.count = 0;
    } else {
      pending.runs[count++] = run;
      previous = run;
    }
  }
  // Keep every reusable run owned once, including emptied runs beyond the live prefix.
  for (const run of runs) if (run.count === 0) pending.runs[count++] = run;
  pending.runCount = runs.filter((run) => run.count > 0).length;
}

/** Applies membership deltas without visiting stable mounted nodes. */
export function stageVisibilityDelta(
  pending: PendingReconciliation,
  slice: MountSlice,
  previews: ReadonlyMap<string, PreviewTransform>,
  options: DeltaStageOptions,
): MountYieldReason | undefined {
  const delta = pending.delta!;
  if (delta.phase === "paths") delta.phase = "deferred";
  if (delta.phase === "warm") {
    const reason = stageDeltaCandidates(pending, slice, previews, options);
    if (reason !== undefined || delta.deferred.length === 0) return reason;
    delta.ids = delta.deferred;
    delta.deferred = [];
    delta.index = 0;
    delta.phase = "deferred";
  }
  const reason = stageDeferredCandidates(pending, slice, previews, options);
  if (reason === "paths") delta.phase = "paths";
  return reason;
}

/** Once warm entrants had their chance, drain local cold work without repeated warm scans. */
function stageDeferredCandidates(
  pending: PendingReconciliation,
  slice: MountSlice,
  previews: ReadonlyMap<string, PreviewTransform>,
  options: DeltaStageOptions,
): MountYieldReason | undefined {
  const delta = pending.delta!;
  while (delta.index < delta.ids.length) {
    const blocked = slice.blockingReason();
    if (blocked !== undefined) return blocked;
    if (!slice.canPublish) return "budget";
    const id = delta.ids[delta.index]!;
    const record = options.store.get(id);
    if (record === undefined || !options.visibility.contains(id) || options.mounted.has(id)) {
      delta.index += 1;
      slice.record();
      continue;
    }
    if (!pending.entrants.has(id)) options.stage(pending, record, slice, previews);
    if (!pending.entrants.has(id)) {
      if (options.waiting()) return "paths";
      const prepared = options.prepareDeferred();
      if (prepared === undefined) return "deadline";
      const index = prepared === id ? delta.index : delta.ids.indexOf(prepared, delta.index);
      if (index < 0) throw new Error("Prepared scene path is outside the deferred target.");
      delta.ids[index] = id;
      delta.ids[delta.index] = prepared;
    }
    const reason = stageDeltaEntry(delta.ids[delta.index]!, pending, slice, previews, options);
    if (reason !== undefined) return reason;
    delta.index += 1;
  }
  return undefined;
}

function stageDeltaCandidates(
  pending: PendingReconciliation,
  slice: MountSlice,
  previews: ReadonlyMap<string, PreviewTransform>,
  options: DeltaStageOptions,
): MountYieldReason | undefined {
  const delta = pending.delta;
  if (delta === undefined) return undefined;
  const building = delta.priority?.build(slice);
  if (building !== undefined) return building;
  while (delta.index < delta.ids.length || (delta.priority?.count ?? 0) > 0) {
    const blocked = slice.blockingReason();
    if (blocked !== undefined) return blocked;
    if (delta.index === delta.ids.length) delta.ids.push(delta.priority!.take()!);
    const id = delta.ids[delta.index]!;
    const reason = stageDeltaEntry(id, pending, slice, previews, options);
    if (reason !== undefined) return reason;
    delta.index += 1;
  }
  return undefined;
}

function stageDeltaEntry(
  id: string,
  pending: PendingReconciliation,
  slice: MountSlice,
  previews: ReadonlyMap<string, PreviewTransform>,
  options: DeltaStageOptions,
): MountYieldReason | undefined {
  options.instrumentation.visibilityReconcileVisits += 1;
  if (options.mounted.has(id)) {
    slice.record();
    return undefined;
  }
  const record = options.store.get(id);
  if (record === undefined || !options.visibility.contains(id)) {
    slice.record();
    return undefined;
  }
  const reason = slice.blockingReason();
  if (reason !== undefined) return reason;
  if (!slice.canPublish && !options.detachedCache?.isConnected(id)) return "budget";
  const entry = pending.entrants.get(id) ?? options.stage(pending, record, slice, previews);
  if (entry === undefined) {
    pending.delta!.deferred.push(id);
    slice.record();
    return undefined;
  }
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
  if (!slice.claimPublicationNodes(publicationRootCount(entry))) return "budget";
  const run = options.run(record.band, successor);
  run.entries[0] = entry;
  run.entrants[0] = true;
  run.count = 1;
  pending.runCount += 1;
  slice.record();
  return undefined;
}

function deltaSuccessor(
  pending: PendingReconciliation,
  record: SceneElementRecord,
  slice: MountSlice,
  options: DeltaStageOptions,
): MountedSceneElement | "deadline" | undefined {
  const delta = pending.delta!;
  if (options.detachedCache !== undefined) return options.detachedCache.successor(record);
  if (delta.order !== undefined) return delta.order.successor(record.id, record.band);
  const band = pending.visibility[record.band];
  const search = delta.search;
  const low = search?.id === record.id ? search.low : successorStart(record, pending, options);
  delta.publicationPositions ??= new Map();
  delta.publicationPositions.set(record.id, low - 1);
  const cached = delta.successors[record.band];
  if (cached !== undefined && low >= cached.start && low <= cached.index) {
    const published = delta.publishedOrder?.successorAfter(low - 1, record.band);
    return published !== undefined &&
      (cached.entry === undefined || published.rank < cached.entry.rank)
      ? published
      : cached.entry;
  }
  const start = search?.id === record.id ? Math.max(low, search.index) : low;
  for (let index = start; index < band.count; index += 1) {
    if (slice.blockingReason() !== undefined) {
      delta.search = { id: record.id, index, low };
      return "deadline";
    }
    const mounted = options.mounted.get(band.ids[index]!);
    options.instrumentation.visibilityReconcileVisits += 1;
    slice.record();
    if (mounted !== undefined && mounted.detachedPathCount === 0) {
      delta.successors[record.band] = { start: low, index, entry: mounted };
      delta.search = undefined;
      return mounted;
    }
  }
  delta.successors[record.band] = { start: low, index: band.count, entry: undefined };
  delta.search = undefined;
  return undefined;
}

function successorStart(
  record: Pick<SceneElementRecord, "id" | "rank" | "band">,
  pending: PendingReconciliation,
  options: Pick<DeltaStageOptions, "store" | "instrumentation">,
): number {
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
  return low;
}
