import type { RenderBand } from "../../domain/commands/render-bands";
import type { Bounds } from "../../domain/geometry/primitives";
import type { StrokePathGeometry } from "../../domain/geometry/stroke-path";
import type { InkElementV1, PageV1 } from "../../domain/schema/public";
import type { PathPresentation } from "./element-presentation";

type SceneDirtyDomain = "connection" | "geometry" | "order" | "paint" | "visibility";

export interface SceneElementRecord {
  readonly band: RenderBand;
  readonly bounds: Bounds;
  readonly element: InkElementV1;
  readonly geometryVersion: number;
  readonly id: string;
  readonly paintVersion: number;
  readonly rank: number;
}

export interface SceneDeltaEntry {
  readonly after?: InkElementV1 | null;
  readonly before?: InkElementV1 | null;
  readonly domains: readonly SceneDirtyDomain[];
  readonly id: string;
}

export interface SceneStoreDelta {
  readonly affected: readonly SceneDeltaEntry[];
}

export interface SpatialQuerySink {
  add(id: string): void;
}

/**
 * Read-only view of the authoritative element store and its spatial index.
 * `query` must perform exact conservative-bounds rejection before publishing IDs.
 */
export interface SceneStorePort {
  get(id: string): SceneElementRecord | undefined;
  query(bounds: Bounds, sink: SpatialQuerySink): void;
}

export interface SceneViewport {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

interface SceneLayoutPort {
  readViewport(): SceneViewport;
}

export interface SceneScheduler {
  cancelAnimationFrame(handle: number): void;
  now(): number;
  requestAnimationFrame(callback: FrameRequestCallback): number;
}

export interface SceneCamera {
  readonly x: number;
  readonly zoom: number;
}

export type DocumentScheme = "dark" | "light";

export interface SceneInputHandlers {
  readonly contextmenu?: (event: MouseEvent) => void;
  readonly keydown?: (event: KeyboardEvent) => void;
  readonly pointercancel?: (event: PointerEvent) => void;
  readonly pointerdown?: (event: PointerEvent) => void;
  readonly pointermove?: (event: PointerEvent) => void;
  readonly pointerup?: (event: PointerEvent) => void;
  readonly wheel?: (event: WheelEvent) => void;
}

export interface SceneRendererOptions {
  readonly accessibleName?: string;
  readonly container: HTMLElement;
  readonly frameBudgetMs?: number | (() => number);
  readonly inputHandlers?: SceneInputHandlers;
  readonly layout: SceneLayoutPort;
  readonly page: PageV1;
  readonly onSceneCommitted?: () => void;
  readonly onResourceUsageChanged?: () => void;
  readonly reducedMotion?: boolean;
  readonly scheduler?: SceneScheduler;
  readonly store: SceneStorePort;
}

interface LivePathPartState {
  readonly d: string;
  readonly presentation: PathPresentation;
}

export interface LivePathState {
  /** The live path's render band. Drag previews default to the content band. */
  readonly band?: RenderBand;
  readonly parts: readonly LivePathPartState[];
}

export interface SceneLiveStrokeChunk {
  readonly geometry: Readonly<StrokePathGeometry>;
}

interface SceneLiveStrokeTail {
  readonly geometry: Readonly<StrokePathGeometry>;
}

/**
 * Structural rendering port implemented by the editor's `LiveStrokePreview`.
 * Finalized chunks may only be appended during one live-stroke lifetime.
 */
export interface SceneLiveStrokePreview {
  readonly finalizedChunks: readonly SceneLiveStrokeChunk[];
  readonly tail: SceneLiveStrokeTail;
}

export interface SceneInstrumentationSnapshot {
  readonly attributeWrites: number;
  readonly backgroundBuilds: number;
  readonly backgroundBudgetDeferrals: number;
  readonly backgroundCacheHits: number;
  readonly collectionAllocations: number;
  readonly contentAttributeWrites: number;
  readonly contentGeometryWrites: number;
  readonly domEntrants: number;
  readonly domExits: number;
  readonly domFragmentRuns: number;
  readonly domReorders: number;
  readonly frames: number;
  readonly geometryBuilds: number;
  readonly layoutReads: number;
  readonly liveChunkNodesCreated: number;
  readonly liveChunkNodesRemoved: number;
  readonly liveMaximumChunkNodes: number;
  readonly liveMaximumTailNodes: number;
  readonly livePreviewUpdates: number;
  readonly liveTailNodesCreated: number;
  readonly liveTailNodesRemoved: number;
  readonly maximumMountSliceElements: number;
  readonly maximumMountSliceGeometryCost: number;
  readonly maximumMountSliceStrokePoints: number;
  readonly mountBudgetYields: number;
  readonly mountDeadlineYields: number;
  readonly mountSlices: number;
  readonly motionCacheBytes: number;
  readonly motionCacheEntries: number;
  readonly motionCrossfades: number;
  readonly motionEntrances: number;
  readonly motionEvictions: number;
  readonly motionFrames: number;
  readonly motionGeometryTransitions: number;
  readonly motionInterruptions: number;
  readonly motionRemovalInvalidations: number;
  readonly motionTombstones: number;
  readonly pathCacheBytes: number;
  readonly pathCacheEntries: number;
  readonly pathCacheEvictions: number;
  readonly pathCacheHits: number;
  readonly scheduledFrames: number;
  readonly spatialQueries: number;
  readonly staleFrames: number;
  readonly themeWrites: number;
  readonly visibilityCandidateCacheHits: number;
  readonly visibilityHysteresisHits: number;
  readonly visibilitySortSkips: number;
}

export interface MutableSceneInstrumentation {
  attributeWrites: number;
  backgroundBuilds: number;
  backgroundBudgetDeferrals: number;
  backgroundCacheHits: number;
  collectionAllocations: number;
  contentAttributeWrites: number;
  contentGeometryWrites: number;
  domEntrants: number;
  domExits: number;
  domFragmentRuns: number;
  domReorders: number;
  frames: number;
  geometryBuilds: number;
  layoutReads: number;
  liveChunkNodesCreated: number;
  liveChunkNodesRemoved: number;
  liveMaximumChunkNodes: number;
  liveMaximumTailNodes: number;
  livePreviewUpdates: number;
  liveTailNodesCreated: number;
  liveTailNodesRemoved: number;
  maximumMountSliceElements: number;
  maximumMountSliceGeometryCost: number;
  maximumMountSliceStrokePoints: number;
  mountBudgetYields: number;
  mountDeadlineYields: number;
  mountSlices: number;
  motionCacheBytes: number;
  motionCacheEntries: number;
  motionCrossfades: number;
  motionEntrances: number;
  motionEvictions: number;
  motionFrames: number;
  motionGeometryTransitions: number;
  motionInterruptions: number;
  motionRemovalInvalidations: number;
  motionTombstones: number;
  pathCacheBytes: number;
  pathCacheEntries: number;
  pathCacheEvictions: number;
  pathCacheHits: number;
  scheduledFrames: number;
  spatialQueries: number;
  staleFrames: number;
  themeWrites: number;
  visibilityCandidateCacheHits: number;
  visibilityHysteresisHits: number;
  visibilitySortSkips: number;
}
