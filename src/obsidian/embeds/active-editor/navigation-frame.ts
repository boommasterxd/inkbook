import {
  applyAnchoredZoom,
  anchoredScrollTop,
  calculateFitZoom,
  calculateZoomLimits,
  clampCameraX,
  renderedContainerHeight,
  type ZoomFrameState,
  type ScrollBounds,
} from "../../../editor/zoom/index";
import { browserScrollMetrics, type BrowserScrollElement } from "../../scrolling/index";
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
  const pageHeight = Math.max(0, input.pageHeight());
  const anchor =
    input.frame.anchor ??
    pagePointAnchor(
      input.layout,
      visibleCenterPoint(input.layout, input.cameraX, input.zoom),
      input.cameraX,
      input.zoom,
    );
  const blockSize = renderedContainerHeight(pageHeight, zoom);
  const scrollBounds = projectedScrollBounds(input.scrollOwner, input.layout, blockSize);
  if (input.pinch !== undefined) {
    return resolvePinchFrame(input, input.pinch, { blockSize, fitZoom, zoom }, scrollBounds);
  }
  const anchored = applyAnchoredZoom({
    anchor,
    containerWidth: input.layout.containerWidth,
    derivedPageHeight: pageHeight,
    embedTopInScrollContent: input.layout.embedTopInScrollContent,
    oldCameraX: input.cameraX,
    oldScrollTop: input.layout.scrollTop,
    oldZoom: input.zoom,
    requestedZoom: zoom,
    scrollBounds,
    zoomLimits: limits,
  });
  return {
    blockSize,
    cameraX: clampCameraX(
      anchored.camera.x + input.frame.panX / anchored.camera.zoom,
      input.layout.containerWidth,
      anchored.camera.zoom,
    ),
    fitZoom,
    unclampedScrollTop:
      anchoredScrollTop(
        input.layout.scrollTop,
        anchor.anchorViewportY,
        input.layout.embedTopInScrollContent,
        input.zoom,
        anchored.camera.zoom,
      ) - input.frame.panY,
    scrollTop: applyNativePan(anchored.scrollTop, input.frame.panY, scrollBounds),
    zoom: anchored.camera.zoom,
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
