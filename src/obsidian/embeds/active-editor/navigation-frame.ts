import {
  applyAnchoredZoom,
  calculateFitZoom,
  calculateZoomLimits,
  clampCameraX,
  renderedContainerHeight,
  type ZoomFrameState,
} from "../../../editor/zoom/index";
import type { BrowserScrollElement } from "../../scrolling/index";
import { applyNativePan, pagePointAnchor, visibleCenterPoint } from "./navigation-layout";
import type { NavigationLayoutRead } from "./navigation-layout";
import { projectedScrollBounds } from "./navigation-helpers";

interface NavigationFrameInput {
  readonly cameraX: number;
  readonly frame: ZoomFrameState;
  readonly layout: NavigationLayoutRead;
  readonly pageHeight: () => number;
  readonly scrollOwner: BrowserScrollElement;
  readonly zoom: number;
}

export interface NavigationFrameResult {
  readonly blockSize: number;
  readonly cameraX: number;
  readonly fitZoom: number;
  readonly scrollTop: number;
  readonly zoom: number;
}

export function resolveNavigationFrame(
  input: NavigationFrameInput,
): NavigationFrameResult | undefined {
  const fitZoom = calculateFitZoom(input.layout.containerWidth);
  if (fitZoom === undefined) return undefined;
  const limits = calculateZoomLimits(fitZoom);
  const zoom = Math.max(fitZoom, Math.min(limits.maxZoom, input.zoom * input.frame.factor));
  if (zoom === input.zoom && input.frame.panY === 0) {
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
    scrollTop: applyNativePan(anchored.scrollTop, input.frame.panY, scrollBounds),
    zoom: anchored.camera.zoom,
  };
}
