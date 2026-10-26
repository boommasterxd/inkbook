import type { PreparedPressureGeometryPort } from "../../domain/geometry/pressure/prepared-pressure-geometry";
import type { RenderBand } from "../../domain/commands/render-bands";
import type { Bounds } from "../../domain/geometry/primitives";
import type { StrokePathGeometry } from "../../domain/geometry/stroke-path";
import type { InkElementV1, PageV1 } from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { PathPresentation } from "./content/element-presentation";

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
  readonly afterBounds?: Bounds | null;
  readonly afterGeometryVersion?: number;
  readonly afterPaintVersion?: number;
  readonly before?: InkElementV1 | null;
  readonly beforeBounds?: Bounds | null;
  readonly domains: readonly SceneDirtyDomain[];
  readonly id: string;
}

export interface SceneStoreDelta {
  readonly affected: readonly SceneDeltaEntry[];
  /** Captured at commit time; only membership changes use history fade feedback. */
  readonly historyReplay?: boolean;
}

export interface SpatialQuerySink {
  add(id: string): void;
}

interface SceneSpatialQueryCursor extends Pick<
  import("../../domain/spatial/query-cursor").SpatialQueryCursor<string>,
  "advance" | "cancel"
> {
  memoryUsage?(): number;
}

/**
 * Read-only view of the authoritative element store and its spatial index.
 * `query` must perform exact conservative-bounds rejection before publishing IDs.
 */
export interface SceneStorePort {
  prepareScenePaths?:
    import("../../domain/geometry/prepared-scene-paths").ScenePathPreparation | undefined;
  pressureGeometry?(id: string, geometryVersion: number): PreparedPressureGeometryPort;
  get(id: string): SceneElementRecord | undefined;
  beginOrder?(): import("../../domain/store/mutations/order-cursor").StoreOrderCursor;
  beginQuery?(bounds: Bounds): SceneSpatialQueryCursor;
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

export interface SceneCamera {
  readonly x: number;
  readonly zoom: number;
}

export type PreviewStrokeWidth = "preserve" | "scale";
export type PreviewBoundsTransform = (bounds: Bounds, paintPadding?: number) => Bounds;
export interface PreviewMembershipContext {
  readonly transformBounds?: PreviewBoundsTransform | undefined;
  readonly envelope?: Bounds | undefined;
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
  readonly inputHandlers?: SceneInputHandlers;
  readonly surfaceThemeRoot?: HTMLElement;
  readonly onSurfaceFailure?: () => void;
  readonly layout: SceneLayoutPort;
  readonly isInputActive?: () => boolean;
  readonly waitForBackground?: () => Promise<void> | undefined;
  readonly page: PageV1;
  /** The presentation explicitly releases initial exact-viewport preparation after its handoff. */
  readonly deferInitialOverscan?: boolean;
  /** Vertical preloading distance above and below the viewport in screen pixels. */
  readonly scrollPreloadMarginPx?: number;
  readonly onSceneCommitted?: () => void;
  readonly onResourceUsageChanged?: () => void;
  readonly reducedMotion?: boolean;
  readonly workScheduler: WorkScheduler;
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
  readonly domRootsPublished: number;
  readonly detachedCacheBytes: number;
  readonly detachedCacheEntries: number;
  readonly detachedCacheEvictions: number;
  readonly detachedCacheHits: number;
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
  readonly selectionTraceNodesCreated: number;
  readonly selectionTraceNodesRemoved: number;
  readonly selectionTraceGeometryBuilds: number;
  readonly selectionTraceAttributeWrites: number;
  readonly spatialQueries: number;
  readonly staleFrames: number;
  readonly themeWrites: number;
  readonly visibilityCandidateCacheHits: number;
  readonly visibilityCandidateVisits: number;
  readonly visibilityHysteresisHits: number;
  readonly visibilityReconcileVisits: number;
  readonly exitReadinessVisits: number;
  readonly exitReadinessComparisons: number;
  readonly visibilitySortSkips: number;
  readonly visibilityPathYields: number;
  readonly visibilityPublicationYields: number;
  readonly visibilityDeadlineYields: number;
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
  domRootsPublished: number;
  detachedCacheBytes: number;
  detachedCacheEntries: number;
  detachedCacheEvictions: number;
  detachedCacheHits: number;
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
  selectionTraceNodesCreated: number;
  selectionTraceNodesRemoved: number;
  selectionTraceGeometryBuilds: number;
  selectionTraceAttributeWrites: number;
  spatialQueries: number;
  staleFrames: number;
  themeWrites: number;
  visibilityCandidateCacheHits: number;
  visibilityCandidateVisits: number;
  visibilityHysteresisHits: number;
  visibilityReconcileVisits: number;
  exitReadinessVisits: number;
  exitReadinessComparisons: number;
  visibilitySortSkips: number;
  visibilityPathYields: number;
  visibilityPublicationYields: number;
  visibilityDeadlineYields: number;
}
