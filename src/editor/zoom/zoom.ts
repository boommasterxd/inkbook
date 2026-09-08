import { requireFinite, requireNonNegative, requirePositive } from "./numeric-validation";

/** The page width used by the width-fit camera, including the page margin. */
export const OUTER_PAGE_WIDTH = 2000 + 2 * 24.3;

/** One keyboard or normalized wheel step changes the zoom by this factor. */
export const ZOOM_STEP_FACTOR = 1.08;

/** The largest multiplicative zoom change applied in one animation frame. */
export const MAX_FRAME_ZOOM_FACTOR = 1.35;

export interface ZoomLimits {
  readonly minZoom: number;
  readonly maxZoom: number;
}

interface Camera {
  readonly x: number;
  readonly zoom: number;
}

export interface ZoomAnchor {
  /** Horizontal coordinate in the embed's local screen space. */
  readonly anchorX: number;
  /** Vertical coordinate in the pane viewport. */
  readonly anchorViewportY: number;
}

export interface ScrollBounds {
  readonly min: number;
  readonly max: number;
}

export interface AnchoredZoomInput {
  readonly oldCameraX: number;
  readonly oldScrollTop: number;
  readonly oldZoom: number;
  readonly requestedZoom: number;
  readonly containerWidth: number;
  readonly derivedPageHeight: number;
  readonly embedTopInScrollContent: number;
  readonly anchor: ZoomAnchor;
  readonly scrollBounds: ScrollBounds;
  readonly zoomLimits: ZoomLimits;
  readonly outerPageWidth?: number;
}

export interface AnchoredZoomResult {
  readonly camera: Camera;
  readonly scrollTop: number;
  readonly renderedContainerHeight: number;
}

export interface ResizeZoomInput {
  readonly oldCameraX: number;
  readonly oldRenderedContainerHeight: number;
  readonly oldScrollTop: number;
  readonly oldZoom: number;
  readonly oldFitZoom: number;
  readonly newFitZoom: number;
  readonly containerWidth: number;
  readonly derivedPageHeight: number;
  readonly embedTopInScrollContent: number;
  readonly viewportWidth: number;
  readonly anchorViewportY: number;
  readonly scrollBounds: ScrollBounds;
  readonly outerPageWidth?: number;
}

/**
 * Calculates width-fit zoom. A non-positive width means that the layout is
 * hidden or not measured yet, so no camera update can be derived.
 */
export function calculateFitZoom(
  containerWidth: number,
  outerPageWidth = OUTER_PAGE_WIDTH,
): number | undefined {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return undefined;
  }

  requirePositive(outerPageWidth, "outerPageWidth");
  return containerWidth / outerPageWidth;
}

export function calculateZoomLimits(fitZoom: number): ZoomLimits {
  requirePositive(fitZoom, "fitZoom");

  return {
    minZoom: fitZoom,
    maxZoom: Math.max(5, fitZoom * 5),
  };
}

export function clamp(value: number, min: number, max: number): number {
  requireFinite(value, "value");
  requireFinite(min, "min");
  requireFinite(max, "max");
  if (min > max) {
    throw new RangeError("min must not be greater than max");
  }

  return Math.min(Math.max(value, min), max);
}

export function clampZoom(zoom: number, limits: ZoomLimits): number {
  return clamp(zoom, limits.minZoom, limits.maxZoom);
}

/** Returns the exact multiplicative change for whole wheel or keyboard steps. */
export function zoomFactorForSteps(steps: number): number {
  if (!Number.isSafeInteger(steps)) {
    throw new RangeError("steps must be a safe integer");
  }
  return requirePositive(ZOOM_STEP_FACTOR ** steps, "zoomFactor");
}

export function renderedContainerHeight(derivedPageHeight: number, zoom: number): number {
  requireNonNegative(derivedPageHeight, "derivedPageHeight");
  requirePositive(zoom, "zoom");
  return derivedPageHeight * zoom;
}

/** Returns the horizontal camera interval that keeps both viewport edges covered. */
export function cameraXBounds(
  containerWidth: number,
  zoom: number,
  outerPageWidth = OUTER_PAGE_WIDTH,
): ScrollBounds {
  requirePositive(containerWidth, "containerWidth");
  requirePositive(zoom, "zoom");
  requirePositive(outerPageWidth, "outerPageWidth");

  const minimum = containerWidth / zoom - outerPageWidth;
  // A caller should never request a zoom below fit, but returning a collapsed
  // interval keeps the camera safe if a stale layout measurement reaches this
  // pure helper during a resize.
  if (minimum > 0) {
    return { min: 0, max: 0 };
  }

  return { min: minimum, max: 0 };
}

/** Clamps a horizontal camera position without introducing side blank space. */
export function clampCameraX(
  cameraX: number,
  containerWidth: number,
  zoom: number,
  outerPageWidth = OUTER_PAGE_WIDTH,
): number {
  const bounds = cameraXBounds(containerWidth, zoom, outerPageWidth);
  return clamp(cameraX, bounds.min, bounds.max);
}

/**
 * Computes the camera position that leaves the page point under an anchor in
 * place, then applies the horizontal page-coverage clamp.
 */
export function anchoredCameraX(
  anchorX: number,
  oldZoom: number,
  oldCameraX: number,
  newZoom: number,
  containerWidth: number,
  outerPageWidth = OUTER_PAGE_WIDTH,
): number {
  requireFinite(anchorX, "anchorX");
  requirePositive(oldZoom, "oldZoom");
  requireFinite(oldCameraX, "oldCameraX");
  requirePositive(newZoom, "newZoom");

  const pageX = anchorX / oldZoom - oldCameraX;
  const candidateCameraX = anchorX / newZoom - pageX;
  return clampCameraX(candidateCameraX, containerWidth, newZoom, outerPageWidth);
}

/**
 * Computes native-scroll anchoring. Vertical movement is deliberately kept out
 * of the camera: the pane scroller is the sole vertical scroll owner.
 */
export function anchoredScrollTop(
  oldScrollTop: number,
  anchorViewportY: number,
  embedTopInScrollContent: number,
  oldZoom: number,
  newZoom: number,
  scrollBounds: ScrollBounds,
): number {
  requireFinite(oldScrollTop, "oldScrollTop");
  requireFinite(anchorViewportY, "anchorViewportY");
  requireFinite(embedTopInScrollContent, "embedTopInScrollContent");
  requirePositive(oldZoom, "oldZoom");
  requirePositive(newZoom, "newZoom");

  const pageY = (oldScrollTop + anchorViewportY - embedTopInScrollContent) / oldZoom;
  const candidateScrollTop = embedTopInScrollContent + pageY * newZoom - anchorViewportY;
  return clampScrollTop(candidateScrollTop, scrollBounds);
}

export function clampScrollTop(scrollTop: number, scrollBounds: ScrollBounds): number {
  return clamp(scrollTop, scrollBounds.min, scrollBounds.max);
}

/**
 * Applies one complete anchored zoom frame. The caller supplies scroll bounds
 * for the post-height layout, so clamping happens after the new height exists.
 */
export function applyAnchoredZoom(input: AnchoredZoomInput): AnchoredZoomResult {
  const {
    oldCameraX,
    oldScrollTop,
    oldZoom,
    requestedZoom,
    containerWidth,
    derivedPageHeight,
    embedTopInScrollContent,
    anchor,
    scrollBounds,
    zoomLimits,
  } = input;
  const outerPageWidth = input.outerPageWidth ?? OUTER_PAGE_WIDTH;
  const newZoom = clampZoom(requestedZoom, zoomLimits);
  const cameraX = anchoredCameraX(
    anchor.anchorX,
    oldZoom,
    oldCameraX,
    newZoom,
    containerWidth,
    outerPageWidth,
  );
  const scrollTop = anchoredScrollTop(
    oldScrollTop,
    anchor.anchorViewportY,
    embedTopInScrollContent,
    oldZoom,
    newZoom,
    scrollBounds,
  );

  return {
    camera: { x: cameraX, zoom: newZoom },
    scrollTop,
    renderedContainerHeight: renderedContainerHeight(derivedPageHeight, newZoom),
  };
}

/** Calculates the resized zoom from the old relative magnification. */
export function resizeZoom(oldZoom: number, oldFitZoom: number, newFitZoom: number): number {
  requirePositive(oldZoom, "oldZoom");
  requirePositive(oldFitZoom, "oldFitZoom");
  const limits = calculateZoomLimits(requirePositive(newFitZoom, "newFitZoom"));
  const relativeMagnification = oldZoom / oldFitZoom;
  return clampZoom(relativeMagnification * newFitZoom, limits);
}

/**
 * Preserves the viewport centre while applying a fit-zoom change. The new
 * container width must already reflect the settled native scrollbar lease.
 */
export function applyResize(input: ResizeZoomInput): AnchoredZoomResult {
  const newZoom = resizeZoom(input.oldZoom, input.oldFitZoom, input.newFitZoom);
  const newRenderedHeight = renderedContainerHeight(input.derivedPageHeight, newZoom);
  requireNonNegative(input.oldRenderedContainerHeight, "oldRenderedContainerHeight");
  const projectedScrollBounds = {
    min: input.scrollBounds.min,
    max: Math.max(
      input.scrollBounds.min,
      input.scrollBounds.max + newRenderedHeight - input.oldRenderedContainerHeight,
    ),
  };
  return applyAnchoredZoom({
    oldCameraX: input.oldCameraX,
    oldScrollTop: input.oldScrollTop,
    oldZoom: input.oldZoom,
    requestedZoom: newZoom,
    containerWidth: input.containerWidth,
    derivedPageHeight: input.derivedPageHeight,
    embedTopInScrollContent: input.embedTopInScrollContent,
    anchor: {
      anchorX: input.viewportWidth / 2,
      anchorViewportY: input.anchorViewportY,
    },
    scrollBounds: projectedScrollBounds,
    zoomLimits: calculateZoomLimits(input.newFitZoom),
    ...(input.outerPageWidth === undefined ? {} : { outerPageWidth: input.outerPageWidth }),
  });
}

/** Returns the bounded factor for a coalesced animation-frame zoom update. */
export function clampFrameZoomFactor(factor: number, maxFactor = MAX_FRAME_ZOOM_FACTOR): number {
  requirePositive(factor, "factor");
  requirePositive(maxFactor, "maxFactor");
  if (maxFactor < 1) {
    throw new RangeError("maxFactor must be at least one");
  }
  return clamp(factor, 1 / maxFactor, maxFactor);
}
