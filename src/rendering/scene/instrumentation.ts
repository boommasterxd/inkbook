import type { MutableSceneInstrumentation, SceneInstrumentationSnapshot } from "./types";
import type { SceneBackgroundCache } from "./content/background-cache";
import type { ScenePathCache } from "./content/path-cache";
import type { DetachedSceneElementCache } from "./content/detached-element-cache";
import type { MountYieldReason } from "./reconciliation/mount-slice";

/** Records the reconciler's actual final blocker, including zero-element slices. */
export function recordVisibilityYield(
  value: MutableSceneInstrumentation,
  reason: MountYieldReason | undefined,
): void {
  if (reason === "paths") value.visibilityPathYields += 1;
  else if (reason === "budget") value.visibilityPublicationYields += 1;
  else if (reason === "deadline") value.visibilityDeadlineYields += 1;
}

export function createInstrumentation(): MutableSceneInstrumentation {
  return {
    attributeWrites: 0,
    backgroundBuilds: 0,
    backgroundBudgetDeferrals: 0,
    backgroundCacheHits: 0,
    collectionAllocations: 0,
    contentAttributeWrites: 0,
    contentGeometryWrites: 0,
    domEntrants: 0,
    domRootsPublished: 0,
    detachedCacheBytes: 0,
    detachedCacheEntries: 0,
    detachedCacheEvictions: 0,
    detachedCacheHits: 0,
    domExits: 0,
    domFragmentRuns: 0,
    domReorders: 0,
    frames: 0,
    geometryBuilds: 0,
    layoutReads: 0,
    liveChunkNodesCreated: 0,
    liveChunkNodesRemoved: 0,
    liveMaximumChunkNodes: 0,
    liveMaximumTailNodes: 0,
    livePreviewUpdates: 0,
    liveTailNodesCreated: 0,
    liveTailNodesRemoved: 0,
    maximumMountSliceElements: 0,
    mountBudgetYields: 0,
    mountDeadlineYields: 0,
    mountSlices: 0,
    motionCacheBytes: 0,
    motionCacheEntries: 0,
    motionCrossfades: 0,
    motionEntrances: 0,
    motionEvictions: 0,
    motionFrames: 0,
    motionGeometryTransitions: 0,
    motionInterruptions: 0,
    motionRemovalInvalidations: 0,
    motionTombstones: 0,
    pathCacheBytes: 0,
    pathCacheEntries: 0,
    pathCacheEvictions: 0,
    pathCacheHits: 0,
    scheduledFrames: 0,
    selectionTraceNodesCreated: 0,
    selectionTraceNodesRemoved: 0,
    selectionTraceGeometryBuilds: 0,
    selectionTraceAttributeWrites: 0,
    spatialQueries: 0,
    staleFrames: 0,
    themeWrites: 0,
    visibilityCandidateCacheHits: 0,
    visibilityCandidateVisits: 0,
    visibilityHysteresisHits: 0,
    visibilityReconcileVisits: 0,
    exitReadinessVisits: 0,
    exitReadinessComparisons: 0,
    visibilitySortSkips: 0,
    visibilityPathYields: 0,
    visibilityPublicationYields: 0,
    visibilityDeadlineYields: 0,
  };
}

export function snapshotInstrumentation(
  value: MutableSceneInstrumentation,
): SceneInstrumentationSnapshot {
  return Object.freeze({ ...value });
}

export function resetInstrumentation(value: MutableSceneInstrumentation): void {
  for (const key of Object.keys(value) as (keyof MutableSceneInstrumentation)[]) {
    value[key] = 0;
  }
}

export function refreshCacheInstrumentation(
  value: MutableSceneInstrumentation,
  background: SceneBackgroundCache,
  pathSource: ScenePathCache,
  detachedSource?: DetachedSceneElementCache,
): void {
  const path = pathSource.statistics();
  value.geometryBuilds = path.builds;
  value.pathCacheBytes = path.bytes;
  value.pathCacheEntries = path.entries;
  value.pathCacheEvictions = path.evictions;
  value.pathCacheHits = path.hits;
  const detached = detachedSource?.statistics();
  value.detachedCacheBytes = detached?.bytes ?? 0;
  value.detachedCacheEntries = detached?.entries ?? 0;
  value.detachedCacheEvictions = detached?.evictions ?? 0;
  value.detachedCacheHits = detached?.hits ?? 0;
  value.backgroundBuilds = background.builds;
  value.backgroundCacheHits = background.hits;
}
