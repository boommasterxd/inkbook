import { describe, expect, it } from "vitest";

import {
  OUTER_PAGE_WIDTH,
  anchoredCameraX,
  anchoredScrollTop,
  applyAnchoredZoom,
  applyResize,
  calculateFitZoom,
  calculateZoomLimits,
  cameraXBounds,
  clamp,
  clampCameraX,
  clampScrollTop,
  clampZoom,
  displayedPercent,
  renderedContainerHeight,
  resizeZoom,
  scrollBoundsForHeight,
  zoomBySteps,
  zoomFactorForSteps,
} from "../../../../src/editor/zoom";

describe("width-fit zoom", () => {
  it("uses the outer page width including both margins", () => {
    expect(OUTER_PAGE_WIDTH).toBe(2048.6);
    expect(calculateFitZoom(1024)).toBeCloseTo(1024 / 2048.6);
  });

  it("defers fit zoom for hidden or invalid widths", () => {
    expect(calculateFitZoom(0)).toBeUndefined();
    expect(calculateFitZoom(-1)).toBeUndefined();
    expect(calculateFitZoom(Number.NaN)).toBeUndefined();
    expect(calculateFitZoom(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("calculates the exact relative bounds and percentage", () => {
    const limits = calculateZoomLimits(0.5);
    expect(limits).toEqual({ minZoom: 0.5, maxZoom: 5 });
    expect(clampZoom(0.1, limits)).toBe(0.5);
    expect(clampZoom(8, limits)).toBe(5);
    expect(displayedPercent(1, 0.5)).toBe(200);
    expect(renderedContainerHeight(1200, 0.5)).toBe(600);
  });

  it("supports a larger absolute maximum for wide containers", () => {
    const limits = calculateZoomLimits(2);
    expect(limits).toEqual({ minZoom: 2, maxZoom: 10 });
  });

  it("applies exact whole keyboard or wheel steps within the zoom limits", () => {
    expect(zoomFactorForSteps(1)).toBe(1.08);
    expect(zoomFactorForSteps(-1)).toBeCloseTo(1 / 1.08);
    expect(zoomBySteps(1, 1, { minZoom: 0.5, maxZoom: 5 })).toBe(1.08);
    expect(zoomBySteps(5, 1, { minZoom: 0.5, maxZoom: 5 })).toBe(5);
    expect(() => zoomFactorForSteps(0.5)).toThrow(RangeError);
  });
});

describe("camera and scroll clamps", () => {
  it("clamps a generic value to an inclusive interval", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(4, 0, 10)).toBe(4);
  });

  it("collapses the horizontal range at fit zoom", () => {
    const width = 1024;
    const fitZoom = calculateFitZoom(width);
    expect(fitZoom).toBeDefined();
    expect(cameraXBounds(width, fitZoom as number)).toEqual({ min: 0, max: 0 });
    expect(clampCameraX(-100, width, fitZoom as number)).toBe(0);
  });

  it("allows only covered page movement above fit", () => {
    const bounds = cameraXBounds(1024, 1, 2048.6);
    expect(bounds.min).toBeCloseTo(1024 - 2048.6);
    expect(bounds.max).toBe(0);
    expect(clampCameraX(-2000, 1024, 1, 2048.6)).toBeCloseTo(bounds.min);
    expect(clampCameraX(50, 1024, 1, 2048.6)).toBe(0);
  });

  it("clamps native scroll bounds after a new height is known", () => {
    const bounds = scrollBoundsForHeight(1200, 500);
    expect(bounds).toEqual({ min: 0, max: 700 });
    expect(clampScrollTop(-1, bounds)).toBe(0);
    expect(clampScrollTop(900, bounds)).toBe(700);
  });
});

describe("anchored zoom", () => {
  it("keeps the horizontal page point under the pointer", () => {
    const oldZoom = 1;
    const oldCameraX = -400;
    const newZoom = 2;
    const anchorX = 300;
    const cameraX = anchoredCameraX(anchorX, oldZoom, oldCameraX, newZoom, 1024);
    const pageX = anchorX / oldZoom - oldCameraX;

    expect(cameraX).toBeCloseTo(anchorX / newZoom - pageX);
    expect(cameraX).toBeGreaterThanOrEqual(1024 / newZoom - OUTER_PAGE_WIDTH);
    expect(cameraX).toBeLessThanOrEqual(0);
  });

  it("keeps the vertical page point under the viewport anchor", () => {
    const oldScrollTop = 300;
    const anchorViewportY = 400;
    const embedTop = 100;
    const oldZoom = 1;
    const newZoom = 2;
    const scrollTop = anchoredScrollTop(oldScrollTop, anchorViewportY, embedTop, oldZoom, newZoom, {
      min: 0,
      max: 2_000,
    });
    const oldPageY = (oldScrollTop + anchorViewportY - embedTop) / oldZoom;
    const newPageY = (scrollTop + anchorViewportY - embedTop) / newZoom;

    expect(newPageY).toBeCloseTo(oldPageY);
  });

  it("uses the native edge when exact vertical anchoring exceeds bounds", () => {
    expect(anchoredScrollTop(0, -20, 0, 1, 4, { min: 0, max: 100 })).toBe(0);
    expect(anchoredScrollTop(100, 200, 0, 1, 4, { min: 0, max: 100 })).toBe(100);
  });

  it("updates zoom, camera, height, and scroll from one atomic result", () => {
    const result = applyAnchoredZoom({
      oldCameraX: 0,
      oldScrollTop: 100,
      oldZoom: 1,
      requestedZoom: 2,
      containerWidth: 1024,
      derivedPageHeight: 1500,
      embedTopInScrollContent: 40,
      anchor: { anchorX: 500, anchorViewportY: 300 },
      scrollBounds: { min: 0, max: 2_000 },
      zoomLimits: { minZoom: 1, maxZoom: 5 },
    });

    expect(result.camera.zoom).toBe(2);
    expect(result.camera.x).toBeLessThanOrEqual(0);
    expect(result.renderedContainerHeight).toBe(3_000);
    expect(result.scrollTop).toBeGreaterThan(100);
  });
});

describe("resize zoom", () => {
  it("preserves relative magnification when fit zoom changes", () => {
    expect(resizeZoom(2, 1, 0.5)).toBe(1);
    expect(resizeZoom(1, 1, 2)).toBe(2);
  });

  it("clamps resized zoom to the new fit range", () => {
    expect(resizeZoom(0.5, 1, 2)).toBe(2);
    expect(resizeZoom(10, 1, 0.5)).toBe(5);
  });

  it("anchors a resize at viewport centre", () => {
    const result = applyResize({
      oldCameraX: -100,
      oldRenderedContainerHeight: 2_000,
      oldScrollTop: 200,
      oldZoom: 2,
      oldFitZoom: 1,
      newFitZoom: 0.5,
      containerWidth: 1024,
      derivedPageHeight: 1000,
      embedTopInScrollContent: 50,
      viewportWidth: 800,
      anchorViewportY: 300,
      scrollBounds: { min: 0, max: 1_500 },
    });

    expect(result.camera.zoom).toBe(1);
    expect(result.camera.x).toBeLessThanOrEqual(0);
    expect(result.renderedContainerHeight).toBe(1_000);
  });

  it("clamps the anchor against post-resize bounds when the page grows", () => {
    const result = applyResize({
      anchorViewportY: 400,
      containerWidth: 1_000,
      derivedPageHeight: 2_000,
      embedTopInScrollContent: 0,
      newFitZoom: 1,
      oldCameraX: 0,
      oldFitZoom: 0.5,
      oldRenderedContainerHeight: 1_000,
      oldScrollTop: 500,
      oldZoom: 0.5,
      scrollBounds: { min: 0, max: 500 },
      viewportWidth: 1_000,
    });

    expect(result.renderedContainerHeight).toBe(2_000);
    expect(result.scrollTop).toBe(1_400);
    expect(result.scrollTop).toBeGreaterThan(500);
  });
});
