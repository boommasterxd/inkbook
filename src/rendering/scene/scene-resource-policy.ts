import type { Bounds } from "../../domain/geometry/primitives";
import {
  DENSE_RECONCILIATION_VISIBLE_ELEMENT_THRESHOLD,
  VIEWPORT_OVERSCAN_SCREEN_PX,
  VISIBILITY_HYSTERESIS_RESERVE_SCREEN_PX,
} from "./constants";
import { DEFAULT_SCROLL_PRELOAD_MARGIN_PX } from "../../domain/settings/types";
import { isScrollPreloadMarginPx } from "../../domain/settings/validation";
import type { SceneMotionController } from "./scene-motion-controller";
import type { ScenePathCache } from "./path-cache";
import type { DetachedSceneElementCache } from "./detached-element-cache";
import type {
  MutableSceneInstrumentation,
  SceneCamera,
  SceneInstrumentationSnapshot,
  SceneViewport,
} from "./types";
import type { SceneBackgroundCache } from "./background-cache";
import * as stats from "./instrumentation";
import type { VisibilityResult } from "./visibility-state";
import type { ActiveDocumentMemoryScenePort } from "../../editor/session/active-document-memory-coordinator";

export class SceneResourcePolicy implements ActiveDocumentMemoryScenePort {
  #denseReconciliation = false;
  #lastMotionCacheBytes = 0;
  #lastPathCacheBytes = 0;
  #memoryPressure = false;

  public get allowsNavigationPreparation(): boolean {
    return !this.#memoryPressure;
  }

  public constructor(
    private readonly pathCache: ScenePathCache,
    private readonly motion: SceneMotionController,
    private readonly onUsageChanged: () => void,
    private readonly previewMemoryUsage: () => number = () => 0,
    private readonly detachedCache?: DetachedSceneElementCache,
  ) {}

  public memoryUsage(): ReturnType<ActiveDocumentMemoryScenePort["memoryUsage"]> {
    return {
      motionCacheBytes: this.motion.cacheMemoryUsage(),
      pathCacheBytes: this.pathMemoryUsage(),
    };
  }

  public refreshInstrumentation(
    value: MutableSceneInstrumentation,
    background: SceneBackgroundCache,
  ): void {
    stats.refreshCacheInstrumentation(value, background, this.pathCache, this.detachedCache);
  }

  public instrumentation(
    value: MutableSceneInstrumentation,
    background: SceneBackgroundCache,
  ): SceneInstrumentationSnapshot {
    this.refreshInstrumentation(value, background);
    this.motion.refreshInstrumentation();
    return stats.snapshotInstrumentation(value);
  }

  public resetInstrumentation(
    value: MutableSceneInstrumentation,
    background: SceneBackgroundCache,
  ): void {
    stats.resetInstrumentation(value);
    background.resetStatistics();
    this.pathCache.resetStatistics();
    this.detachedCache?.resetStatistics();
    this.motion.refreshInstrumentation();
  }

  public releaseCaches(): void {
    this.pathCache.release();
    this.detachedCache?.release();
  }

  public notifyUsageChanged(): void {
    const pathBytes = this.pathMemoryUsage();
    const motionBytes = this.motion.cacheMemoryUsage();
    if (pathBytes === this.#lastPathCacheBytes && motionBytes === this.#lastMotionCacheBytes)
      return;
    this.#lastPathCacheBytes = pathBytes;
    this.#lastMotionCacheBytes = motionBytes;
    this.onUsageChanged();
  }

  public setActiveDocumentMemoryPressure(active: boolean): void {
    if (active === this.#memoryPressure) return;
    this.#memoryPressure = active;
    this.apply();
  }

  public updateVisibility(visibility: VisibilityResult): void {
    const dense =
      visibility.content.count + visibility.highlight.count >
      DENSE_RECONCILIATION_VISIBLE_ELEMENT_THRESHOLD;
    if (dense === this.#denseReconciliation) return;
    this.#denseReconciliation = dense;
    this.apply();
  }

  private apply(): void {
    const constrained = this.#denseReconciliation || this.#memoryPressure;
    // The LRU already enforces byte/entry caps; density alone must not evict reusable paths.
    this.pathCache.setRetentionEnabled(!this.#memoryPressure);
    this.detachedCache?.setRetentionEnabled(!this.#memoryPressure);
    this.motion.setResourceConstrained(constrained);
  }

  private pathMemoryUsage(): number {
    return (
      this.pathCache.cacheMemoryUsage() +
      this.previewMemoryUsage() +
      (this.detachedCache?.memoryUsage() ?? 0)
    );
  }
}

function visiblePageBounds(
  viewport: SceneViewport,
  camera: SceneCamera,
  overscanScreenPx: number,
  verticalOverscanScreenPx = overscanScreenPx,
): Bounds {
  const overscan = overscanScreenPx / camera.zoom;
  const verticalOverscan = verticalOverscanScreenPx / camera.zoom;
  return {
    minX: viewport.left / camera.zoom - camera.x - overscan,
    minY: viewport.top / camera.zoom - verticalOverscan,
    maxX: (viewport.left + viewport.width) / camera.zoom - camera.x + overscan,
    maxY: (viewport.top + viewport.height) / camera.zoom + verticalOverscan,
  };
}

export function visibilityPageBounds(
  viewport: SceneViewport,
  camera: SceneCamera,
  initialVisibleOnly = false,
  scrollPreloadMarginPx = DEFAULT_SCROLL_PRELOAD_MARGIN_PX,
  direction?: SceneVisibilityDirection,
): { readonly envelope: Bounds; readonly retained: Bounds } {
  if (initialVisibleOnly) {
    const bounds = visiblePageBounds(viewport, camera, 0);
    return { envelope: bounds, retained: bounds };
  }
  const retained = visiblePageBounds(
    viewport,
    camera,
    VISIBILITY_HYSTERESIS_RESERVE_SCREEN_PX,
    (scrollPreloadMarginPx * 2) / 3,
  );
  if (direction !== undefined && Math.abs(direction.y) >= Math.abs(direction.x)) {
    const earlierReserve = scrollPreloadMarginPx / (6 * camera.zoom);
    if (direction.y > 0) retained.maxY += earlierReserve;
    if (direction.y < 0) retained.minY -= earlierReserve;
  }
  return {
    envelope: visiblePageBounds(
      viewport,
      camera,
      VIEWPORT_OVERSCAN_SCREEN_PX,
      scrollPreloadMarginPx,
    ),
    retained,
  };
}

interface SceneVisibilityDirection {
  readonly x: number;
  readonly y: number;
}

export function validateScrollPreloadMargin(value: unknown): void {
  if (!isScrollPreloadMarginPx(value))
    throw new RangeError("Scroll preload margin must be an integer from 100 to 800 pixels.");
}
