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
  readonly containerBorderTop?: number;
  readonly containerBounds: ElementContentBox;
  readonly containerWidth: number;
  readonly embedTopInScrollContent: number;
  readonly ownerViewport: ViewportRect;
  readonly ownerWindow: Window | null;
  readonly scrollOwner: BrowserScrollElement;
  readonly scrollTop: number;
}

export type NavigationCursorLayout = Pick<
  NavigationLayoutRead,
  "containerBounds" | "ownerViewport" | "ownerWindow" | "scrollOwner" | "scrollTop"
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
    ownerWindow: layout.ownerWindow,
    scrollOwner: layout.scrollOwner,
    scrollTop: applied.scrollTop,
  };
}

export function readNavigationLayout(
  container: HTMLElement,
  scrollOwner: BrowserScrollElement,
): NavigationLayoutRead | undefined {
  const { borderBox, contentBox: containerBounds } = measureElementBox(container);
  if (!Number.isFinite(containerBounds.width) || containerBounds.width <= 0) return undefined;
  const ownerViewport = readScrollOwnerViewport(scrollOwner);
  const scrollTop = browserScrollMetrics.getScrollTop(scrollOwner);
  return {
    containerBorderTop: borderBox.top,
    containerBounds,
    containerWidth: containerBounds.width,
    embedTopInScrollContent: scrollTop + containerBounds.top - ownerViewport.top,
    ownerViewport,
    ownerWindow: container.ownerDocument.defaultView,
    scrollOwner,
    scrollTop,
  };
}

export function sameNavigationLayout(
  left: NavigationCursorLayout | undefined,
  right: NavigationCursorLayout,
): boolean {
  return (
    left?.scrollOwner === right.scrollOwner &&
    left.ownerWindow === right.ownerWindow &&
    left.scrollTop === right.scrollTop &&
    sameRect(left.containerBounds, right.containerBounds) &&
    sameRect(left.ownerViewport, right.ownerViewport)
  );
}

function sameRect(left: ViewportRect, right: ViewportRect): boolean {
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom
  );
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

export function navigationResizeAnchor(layout: NavigationLayoutRead) {
  return {
    anchorViewportY: (layout.ownerViewport.bottom - layout.ownerViewport.top) / 2,
    embedTopInScrollContent: layout.embedTopInScrollContent,
    oldRenderedContainerHeight: layout.containerBounds.height,
    oldScrollTop: layout.scrollTop,
    scrollBounds: readOwnerScrollBounds(layout.scrollOwner),
    viewportWidth: layout.containerWidth,
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
