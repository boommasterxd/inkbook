import {
  anchoredCameraX,
  anchoredScrollTop,
  calculateFitZoom,
  calculateZoomLimits,
  clampCameraX,
  clampScrollTop,
  renderedContainerHeight,
  type ZoomFrameState,
  type ScrollBounds,
} from "../../../../editor/zoom/index";
import { browserScrollMetrics, type BrowserScrollElement } from "../../../scrolling/index";
import {
  applyNativePan,
  pagePointAnchor,
  visibleCenterPoint,
  wheelAnchor,
  projectNavigationCursorLayout,
} from "./navigation-layout";
import type { NavigationLayoutRead } from "./navigation-layout";
import { projectedScrollBounds } from "./navigation-helpers";
import type { PinchFrameTarget } from "./navigation-pinch";
import type { ActiveEditorNavigationOptions } from "./navigation-types";

interface NavigationFrameInput {
  readonly cameraX: number;
  readonly frame: ZoomFrameState;
  readonly layout: NavigationLayoutRead;
  readonly pageHeight: () => number;
  readonly scrollOwner: BrowserScrollElement;
  readonly zoom: number;
  readonly pinch?: PinchFrameTarget;
}

export interface NavigationFrameResult {
  readonly unclampedScrollTop?: number;
  readonly blockSize: number;
  readonly cameraX: number;
  readonly fitZoom: number;
  readonly scrollTop: number;
  readonly zoom: number;
}

export function applyNavigationFrameLayout(
  resolved: NavigationFrameResult,
  layout: NavigationLayoutRead,
  options: Pick<ActiveEditorNavigationOptions, "applyZoomLayout" | "scrollOwner"> & {
    readonly previousZoom: number;
    readonly panY: number;
    readonly pinch: boolean;
  },
) {
  const adjustsScroll =
    options.panY !== 0 || resolved.zoom !== options.previousZoom || options.pinch;
  const blockSize =
    resolved.zoom === options.previousZoom
      ? layout.containerBounds.height
      : (options.applyZoomLayout({
          blockSize: resolved.blockSize,
          zoom: resolved.zoom,
          layout,
          scrollTop: resolved.unclampedScrollTop ?? resolved.scrollTop,
        }) ?? resolved.blockSize);
  // A height write can clamp or anchor native scrolling even when the requested
  // offset is unchanged. Only skip a proven no-op on the measured geometry.
  const writesScroll =
    adjustsScroll &&
    (resolved.zoom !== options.previousZoom || resolved.scrollTop !== layout.scrollTop);
  if (writesScroll) browserScrollMetrics.setScrollTop(options.scrollOwner, resolved.scrollTop);
  const scrollTop = writesScroll
    ? browserScrollMetrics.getScrollTop(options.scrollOwner)
    : layout.scrollTop;
  return projectNavigationCursorLayout(layout, { blockSize, scrollTop });
}

export function resolveNavigationFrame(
  input: NavigationFrameInput,
): NavigationFrameResult | undefined {
  const fitZoom = calculateFitZoom(input.layout.containerWidth);
  if (fitZoom === undefined) return undefined;
  const limits = calculateZoomLimits(fitZoom);
  const zoom = Math.max(
    fitZoom,
    Math.min(limits.maxZoom, input.pinch?.zoom ?? input.zoom * input.frame.factor),
  );
  if (zoom === input.zoom && input.frame.panY === 0 && input.pinch === undefined) {
    return {
      blockSize: input.layout.containerBounds.height,
      cameraX: clampCameraX(
        input.cameraX + input.frame.panX / zoom,
        input.layout.containerWidth,
        zoom,
      ),
      fitZoom,
      scrollTop: input.layout.scrollTop,
      zoom,
    };
  }
  if (input.pinch !== undefined) {
    const { blockSize, scrollBounds } = navigationScrollRange(input, zoom);
    return resolvePinchFrame(input, input.pinch, { blockSize, fitZoom, zoom }, scrollBounds);
  }
  return resolveAnchoredFrame(input, fitZoom, zoom);
}

function resolveAnchoredFrame(
  input: NavigationFrameInput,
  fitZoom: number,
  zoom: number,
): NavigationFrameResult {
  const anchor =
    input.frame.anchor ??
    pagePointAnchor(
      input.layout,
      visibleCenterPoint(input.layout, input.cameraX, input.zoom),
      input.cameraX,
      input.zoom,
    );
  const width = input.layout.containerWidth;
  const anchoredX = anchoredCameraX(anchor.anchorX, input.zoom, input.cameraX, zoom, width);
  const pannedX = anchoredX + input.frame.panX / zoom;
  const cameraX = input.frame.panX === 0 ? pannedX : clampCameraX(pannedX, width, zoom);
  const anchoredTop = anchoredScrollTop(
    input.layout.scrollTop,
    anchor.anchorViewportY,
    input.layout.embedTopInScrollContent,
    input.zoom,
    zoom,
  );
  const unclampedScrollTop = anchoredTop - input.frame.panY;
  // An upward pan reaching the origin lands at zero for every possible maximum.
  if (zoom === input.zoom && input.frame.panY >= 0 && unclampedScrollTop <= 0) {
    return {
      blockSize: input.layout.containerBounds.height,
      cameraX,
      fitZoom,
      scrollTop: 0,
      unclampedScrollTop,
      zoom,
    };
  }
  const { blockSize, scrollBounds } = navigationScrollRange(input, zoom);
  return {
    blockSize,
    cameraX,
    fitZoom,
    unclampedScrollTop,
    scrollTop: applyNativePan(
      clampScrollTop(anchoredTop, scrollBounds),
      input.frame.panY,
      scrollBounds,
    ),
    zoom,
  };
}

function navigationScrollRange(input: NavigationFrameInput, zoom: number) {
  const blockSize = renderedContainerHeight(Math.max(0, input.pageHeight()), zoom);
  return {
    blockSize,
    scrollBounds: projectedScrollBounds(input.scrollOwner, input.layout, blockSize),
  };
}

function resolvePinchFrame(
  input: NavigationFrameInput,
  pinch: PinchFrameTarget,
  metrics: Pick<NavigationFrameResult, "blockSize" | "fitZoom" | "zoom">,
  scrollBounds: ScrollBounds,
): NavigationFrameResult {
  const midpoint = wheelAnchor(input.layout, pinch.clientPoint);
  const scrollTop =
    input.layout.embedTopInScrollContent +
    pinch.pagePoint.y * metrics.zoom -
    midpoint.anchorViewportY;
  return {
    ...metrics,
    cameraX: clampCameraX(
      midpoint.anchorX / metrics.zoom - pinch.pagePoint.x,
      input.layout.containerWidth,
      metrics.zoom,
    ),
    unclampedScrollTop: scrollTop - input.frame.panY,
    scrollTop: applyNativePan(scrollTop, input.frame.panY, scrollBounds),
  };
}
