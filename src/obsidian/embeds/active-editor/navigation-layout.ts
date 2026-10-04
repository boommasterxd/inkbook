import type { InputPoint } from "../../../editor/input/index";
import type { ZoomAnchor } from "../../../editor/zoom/index";
import { clampScrollTop, type ScrollBounds } from "../../../editor/zoom/index";
import { browserScrollMetrics, type BrowserScrollElement } from "../../scrolling/index";
import { readScrollOwnerViewport } from "../active-scene-viewport";
import { measureElementBox, type ElementContentBox } from "./element-content-box";

interface ViewportRect {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

export interface NavigationLayoutRead {
  readonly containerBounds: ElementContentBox;
  readonly containerWidth: number;
  readonly embedTopInScrollContent: number;
  readonly ownerViewport: ViewportRect;
  readonly scrollTop: number;
}

export type NavigationCursorLayout = Pick<
  NavigationLayoutRead,
  "containerBounds" | "ownerViewport"
>;

/** Project the measured box through our own height/scroll writes without another layout read. */
export function projectNavigationCursorLayout(
  layout: NavigationLayoutRead,
  applied: { readonly blockSize: number; readonly scrollTop: number },
): NavigationCursorLayout {
  const top = layout.containerBounds.top + layout.scrollTop - applied.scrollTop;
  return {
    containerBounds: {
      ...layout.containerBounds,
      top,
      height: applied.blockSize,
      bottom: top + applied.blockSize,
    },
    ownerViewport: layout.ownerViewport,
  };
}

export function readNavigationLayout(
  container: HTMLElement,
  scrollOwner: BrowserScrollElement,
): NavigationLayoutRead | undefined {
  const { contentBox: containerBounds } = measureElementBox(container);
  if (!Number.isFinite(containerBounds.width) || containerBounds.width <= 0) return undefined;
  const ownerViewport = readScrollOwnerViewport(scrollOwner);
  const scrollTop = browserScrollMetrics.getScrollTop(scrollOwner);
  return {
    containerBounds,
    containerWidth: containerBounds.width,
    embedTopInScrollContent: scrollTop + containerBounds.top - ownerViewport.top,
    ownerViewport,
    scrollTop,
  };
}

export function readOwnerScrollBounds(scrollOwner: BrowserScrollElement): ScrollBounds {
  return {
    min: 0,
    max: Math.max(
      0,
      browserScrollMetrics.getScrollHeight(scrollOwner) -
        browserScrollMetrics.getClientHeight(scrollOwner),
    ),
  };
}

export function wheelAnchor(
  layout: NavigationLayoutRead,
  event: Pick<WheelEvent, "clientX" | "clientY">,
): ZoomAnchor {
  return {
    anchorX: event.clientX - layout.containerBounds.left,
    anchorViewportY: event.clientY - layout.ownerViewport.top,
  };
}

export function localScreenPointAnchor(
  layout: NavigationLayoutRead,
  point: InputPoint,
): ZoomAnchor {
  return {
    anchorX: point.x,
    anchorViewportY: layout.containerBounds.top + point.y - layout.ownerViewport.top,
  };
}

export function pagePointAnchor(
  layout: NavigationLayoutRead,
  point: InputPoint,
  cameraX: number,
  zoom: number,
): ZoomAnchor {
  return {
    anchorX: (point.x + cameraX) * zoom,
    anchorViewportY: layout.containerBounds.top + point.y * zoom - layout.ownerViewport.top,
  };
}

export function visibleCenterPoint(
  layout: NavigationLayoutRead,
  cameraX: number,
  zoom: number,
): InputPoint {
  const centerX = intersectionCenter(
    layout.containerBounds.left,
    layout.containerBounds.right,
    layout.ownerViewport.left,
    layout.ownerViewport.right,
  );
  const centerY = intersectionCenter(
    layout.containerBounds.top,
    layout.containerBounds.bottom,
    layout.ownerViewport.top,
    layout.ownerViewport.bottom,
  );
  return {
    x: (centerX - layout.containerBounds.left) / zoom - cameraX,
    y: (centerY - layout.containerBounds.top) / zoom,
  };
}

export function applyNativePan(
  scrollTop: number,
  screenDeltaY: number,
  bounds: ScrollBounds,
): number {
  return clampScrollTop(scrollTop - screenDeltaY, bounds);
}

function intersectionCenter(
  start: number,
  end: number,
  clipStart: number,
  clipEnd: number,
): number {
  const visibleStart = Math.max(start, clipStart);
  const visibleEnd = Math.min(end, clipEnd);
  if (visibleStart <= visibleEnd) return (visibleStart + visibleEnd) / 2;
  return start < clipStart ? clipStart : clipEnd;
}
