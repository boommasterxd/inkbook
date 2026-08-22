import type { MutableSceneInstrumentation, SceneInstrumentationSnapshot } from "./types";
import type { SceneBackgroundCache } from "./background-cache";
import type { ScenePathCache } from "./path-cache";

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
    maximumMountSliceGeometryCost: 0,
    maximumMountSliceStrokePoints: 0,
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
    spatialQueries: 0,
    staleFrames: 0,
    themeWrites: 0,
    visibilityCandidateCacheHits: 0,
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
): void {
  const path = pathSource.statistics();
  value.geometryBuilds = path.builds;
  value.pathCacheBytes = path.bytes;
  value.pathCacheEntries = path.entries;
  value.pathCacheEvictions = path.evictions;
  value.pathCacheHits = path.hits;
  value.backgroundBuilds = background.builds;
  value.backgroundCacheHits = background.hits;
}
