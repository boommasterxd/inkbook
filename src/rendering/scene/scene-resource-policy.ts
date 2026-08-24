import type { Bounds } from "../../domain/geometry/primitives";
import {
  DENSE_RECONCILIATION_VISIBLE_ELEMENT_THRESHOLD,
  VIEWPORT_OVERSCAN_SCREEN_PX,
  VISIBILITY_HYSTERESIS_RESERVE_SCREEN_PX,
} from "./constants";
import type { SceneMotionController } from "./scene-motion-controller";
import type { ScenePathCache } from "./path-cache";
import type { SceneCamera, SceneViewport } from "./types";
import type { VisibilityResult } from "./visibility-state";
import type { ActiveDocumentMemoryScenePort } from "../../editor/session/active-document-memory-coordinator";

export class SceneResourcePolicy implements ActiveDocumentMemoryScenePort {
  #denseReconciliation = false;
  #lastMotionCacheBytes = 0;
  #lastPathCacheBytes = 0;
  #memoryPressure = false;

  public constructor(
    private readonly pathCache: ScenePathCache,
    private readonly motion: SceneMotionController,
    private readonly onUsageChanged: () => void,
  ) {}

  public memoryUsage(): ReturnType<ActiveDocumentMemoryScenePort["memoryUsage"]> {
    return {
      motionCacheBytes: this.motion.cacheMemoryUsage(),
      pathCacheBytes: this.pathCache.cacheMemoryUsage(),
    };
  }

  public notifyUsageChanged(): void {
    const pathBytes = this.pathCache.cacheMemoryUsage();
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
    this.pathCache.setRetentionEnabled(!constrained);
    this.motion.setResourceConstrained(constrained);
  }
}

function visiblePageBounds(
  viewport: SceneViewport,
  camera: SceneCamera,
  overscanScreenPx: number,
): Bounds {
  const overscan = overscanScreenPx / camera.zoom;
  return {
    minX: viewport.left / camera.zoom - camera.x - overscan,
    minY: viewport.top / camera.zoom - overscan,
    maxX: (viewport.left + viewport.width) / camera.zoom - camera.x + overscan,
    maxY: (viewport.top + viewport.height) / camera.zoom + overscan,
  };
}

export function visibilityPageBounds(
  viewport: SceneViewport,
  camera: SceneCamera,
): { readonly envelope: Bounds; readonly retained: Bounds } {
  return {
    envelope: visiblePageBounds(viewport, camera, VIEWPORT_OVERSCAN_SCREEN_PX),
    retained: visiblePageBounds(viewport, camera, VISIBILITY_HYSTERESIS_RESERVE_SCREEN_PX),
  };
}
