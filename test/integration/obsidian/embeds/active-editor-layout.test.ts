import { describe, expect, it } from "vitest";

import { derivePageExtent, PAGE_WIDTH } from "../../../../src/domain/geometry/public";
import { layoutHarness as harness, page } from "./active-editor-layout-fixture";

describe("active editor layout integration", () => {
  it("requests coverage refresh when the observed presentation reveals more canvas", () => {
    const test = harness("full");
    test.invalidateLayout.mockClear();

    test.triggerResize();

    expect(test.invalidateLayout).toHaveBeenCalledWith("coverage");
    test.layout.dispose();
  });

  it("derives width fit from the content box when border and padding are present", () => {
    const test = harness("full", 24);
    test.rect.width = 1_024;
    test.layout.chromeMounted();
    test.work.flushFrames();

    expect(test.onZoom).toHaveBeenCalledWith(1_000 / PAGE_WIDTH);
    test.layout.dispose();
  });

  it("stabilizes the first width and then applies each positive resize frame", () => {
    const test = harness();
    test.layout.chromeMounted();
    test.work.flushFrames();
    test.onZoom.mockClear();
    test.rect.width = 1_100;
    test.layout.contentChanged();
    test.work.flushFrame();
    expect(test.onResize).toHaveBeenCalledWith(
      expect.objectContaining({ fitZoom: 1_100 / PAGE_WIDTH }),
    );
    test.work.flushFrames();

    const previousMeasurements = test.onLayout.mock.calls.length;
    test.layout.chromeChanged();
    test.work.flushFrame();
    expect(test.onLayout.mock.calls.length).toBe(previousMeasurements + 1);
    test.layout.dispose();
  });

  it("remeasures after a conditional control leaves the toolbar at the end of its presence motion", () => {
    const test = harness();
    test.layout.chromeMounted();
    test.work.flushFrames();
    const previousMeasurements = test.onLayout.mock.calls.length;

    test.triggerChromeMutation();

    expect(test.work.frames.size).toBe(1);
    test.work.flushFrame();
    expect(test.onLayout.mock.calls.length).toBe(previousMeasurements + 1);
    test.layout.dispose();
  });

  it("cancels and suppresses measurements while the locking model is released", () => {
    const test = harness();
    test.layout.chromeMounted();
    test.work.flushFrames();
    test.layout.chromeChanged();
    expect(test.work.frames.size).toBe(1);

    test.layout.suspend();
    test.setPageAvailable(false);
    expect(test.work.frames.size).toBe(0);
    test.layout.chromeChanged();
    expect(test.work.frames.size).toBe(0);

    test.layout.dispose();
  });
});

describe("active editor layout sizing", () => {
  it("uses the resize hooks to retain horizontal camera and native-scroll anchoring", () => {
    const test = harness();
    test.layout.chromeMounted();
    test.work.flushFrames();
    const initialFit = 1_000 / PAGE_WIDTH;
    const height = derivePageExtent(page(), null).activeHeight;
    test.layout.applyZoom({ blockSize: height * initialFit * 2, zoom: initialFit * 2 });

    test.rect.width = 1_200;
    test.layout.contentChanged();
    test.work.flushFrames();

    expect(test.onResize).toHaveBeenCalledOnce();
    expect(test.onResize.mock.calls[0]?.[0]).toMatchObject({ fitZoom: 1_200 / PAGE_WIDTH });
    expect(test.onResize.mock.calls[0]?.[0].cameraX).not.toBe(0);
    expect(test.onResize.mock.calls[0]?.[0].scrollTop).not.toBe(500);
    expect(test.onZoom).toHaveBeenCalledOnce();
    test.layout.dispose();
  });

  it("starts transient extension at exactly 24 CSS pixels and restores cancellation", () => {
    const test = harness();
    test.layout.chromeMounted();
    test.work.flushFrames();
    const originalHeight = test.rect.height;
    test.layout.beginSelectionEdgeDrag();

    test.layout.updateSelectionEdgeDrag({ x: 500, y: originalHeight - 24.01 });
    expect(test.work.frames.size).toBe(0);
    test.layout.updateSelectionEdgeDrag({ x: 500, y: originalHeight - 24 });
    expect(test.work.frames.size).toBe(1);
    expect(test.rect.height).toBeCloseTo(originalHeight);
    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(true);
    expect(test.styleProperties.get("--inkbook-page-height-envelope-block-size")).toBeDefined();

    test.layout.finishSelectionEdgeDrag("cancel");
    test.work.flushFrames();
    expect(test.rect.height).toBeCloseTo(originalHeight);
    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(false);
    test.layout.dispose();
  });

  it("applies only one transient buffer per reduced-motion edge update", () => {
    const test = harness("reduced");
    test.layout.chromeMounted();
    test.work.flushFrames();
    const originalHeight = test.rect.height;
    const bufferHeight = 100 * (1_000 / PAGE_WIDTH);
    test.layout.beginSelectionEdgeDrag();

    test.layout.updateSelectionEdgeDrag({ x: 500, y: originalHeight - 10 });
    expect(test.rect.height).toBeCloseTo(originalHeight + bufferHeight);
    test.layout.dispose();
  });
});

describe("active editor layout motion", () => {
  it("reveals a committed larger scene and clips a shrinking scene before resizing it", () => {
    const test = harness("full");
    test.layout.chromeMounted();
    test.work.flushFrames();
    const sizes = pageTransitionSizes(test.rect.height);

    exerciseGrowth(test, sizes);
    exerciseShrink(test, sizes);
    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(false);
    expect(test.styleProperties.has("--inkbook-page-height-envelope-block-size")).toBe(false);
    test.layout.dispose();
  });

  it("retains the exact aligned scene height when CSS pixels round before shrink", () => {
    const test = harness("full");
    test.layout.chromeMounted();
    test.work.flushFrames();
    const grownPageHeight = derivePageExtent(page(), 500).activeHeight;
    const zoom = 1_000 / PAGE_WIDTH;
    test.setMaximumBottom(500);
    test.layout.contentChanged();
    test.work.flushFrames();
    expect(test.setPage).toHaveBeenLastCalledWith(page(), grownPageHeight);

    test.rect.height = Math.floor(test.rect.height * 64) / 64;
    test.setPage.mockClear();
    test.setMaximumBottom(undefined);
    test.layout.contentChanged();
    test.work.flushFrame();

    expect(test.setPage).toHaveBeenCalledWith(page(), grownPageHeight);
    expect(test.setPage).not.toHaveBeenCalledWith(page(), test.rect.height / zoom);
    test.layout.dispose();
  });
});

describe("active editor pending-scene layout motion", () => {
  it("does not reveal an uncommitted growth scene when input interrupts layout", () => {
    const test = harness("full");
    test.layout.chromeMounted();
    test.work.flushFrames();
    const initialHeight = test.rect.height;
    const initialPageHeight = derivePageExtent(page(), null).activeHeight;
    test.setScenePending(true);
    test.setMaximumBottom(500);
    test.layout.contentChanged();
    test.work.flushFrame();

    test.layout.interruptForInput();

    expect(test.rect.height).toBeCloseTo(initialHeight);
    expect(test.setPage).toHaveBeenLastCalledWith(page(), initialPageHeight);
    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(false);
    expect(test.work.frames.size).toBe(1);

    test.work.flushFrame();
    expect(test.rect.height).toBeCloseTo(initialHeight);
    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(true);
    test.setScenePending(false);
    test.layout.sceneCommitted();
    test.work.flushFrames();
    expect(test.rect.height).toBeGreaterThan(initialHeight);
    test.layout.dispose();
  });

  it("waits for a pending scene before completing a reduced-motion height change", () => {
    const test = harness("full");
    test.layout.chromeMounted();
    test.work.flushFrames();
    const initialHeight = test.rect.height;
    const target = derivePageExtent(page(), 500).activeHeight * (1_000 / PAGE_WIDTH);
    test.setScenePending(true);
    test.setMaximumBottom(500);
    test.layout.contentChanged();
    test.work.flushFrame();

    test.layout.updateMotion("reduced");
    expect(test.rect.height).toBeCloseTo(initialHeight);
    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(true);
    test.setScenePending(false);
    test.layout.sceneCommitted();
    expect(test.rect.height).toBeCloseTo(target);
    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(false);
    test.layout.dispose();
  });
});

describe("active editor layout motion preferences", () => {
  it("resolves system reduced motion live and completes an active height transition", () => {
    const test = runningHeightTransition("system");

    test.work.motionQuery.setMatches(true);

    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(false);
    test.layout.dispose();
  });

  it("completes an active transition when the live device preference becomes reduced", () => {
    const test = runningHeightTransition("full");

    test.layout.updateMotion("reduced");

    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(false);
    test.layout.dispose();
  });

  it("commits height, camera, overlay, and native-scroll anchoring in one synchronous update", () => {
    const test = harness("reduced");
    test.layout.chromeMounted();
    test.work.flushFrames();
    test.onResize.mockClear();
    test.layout.beginSelectionEdgeDrag();

    test.layout.setSelectionBottomEdge(true);

    expect(test.onResize).toHaveBeenCalledOnce();
    expect(test.onResize).toHaveBeenCalledWith({
      cameraX: -400,
      fitZoom: 1_000 / PAGE_WIDTH,
      scrollTop: 500,
      zoom: 1_000 / PAGE_WIDTH,
    });
    expect(test.invalidateLayout.mock.calls.length).toBeGreaterThan(0);
    test.layout.dispose();
  });

  it("finishes automatic height motion before a new input gesture proceeds", () => {
    const test = runningHeightTransition("full");
    const targetPageHeight = derivePageExtent(page(), null).activeHeight + 100;
    const zoom = 1_000 / PAGE_WIDTH;

    test.work.flushFrame();
    test.work.flushFrame();
    expect(test.rect.height).toBeGreaterThan(derivePageExtent(page(), null).activeHeight * zoom);
    expect(test.rect.height).toBeLessThan(targetPageHeight * zoom);

    test.layout.interruptForInput();

    expectSettledTransition(test, targetPageHeight, zoom);
  });
});

describe("active editor interrupted height motion", () => {
  it("settles an interpolated page height before applying a zoom frame", () => {
    const test = runningHeightTransition("full");
    const targetPageHeight = derivePageExtent(page(), null).activeHeight + 100;
    const fitZoom = 1_000 / PAGE_WIDTH;
    const zoom = fitZoom * 1.5;

    test.work.flushFrame();
    test.work.flushFrame();
    test.layout.applyZoom({ blockSize: targetPageHeight * zoom, zoom });

    expectSettledTransition(test, targetPageHeight, zoom);
  });

  it("keeps deletion-driven shrinkage on an aligned page height when input interrupts it", () => {
    const test = harness("full");
    const initialPageHeight = derivePageExtent(page(), null).activeHeight;
    const grownPageHeight = derivePageExtent(page(), 500).activeHeight;
    const zoom = 1_000 / PAGE_WIDTH;
    test.layout.chromeMounted();
    test.work.flushFrames();
    test.setMaximumBottom(500);
    test.layout.contentChanged();
    test.work.flushFrames();
    expect(test.rect.height).toBeCloseTo(grownPageHeight * zoom);

    test.setMaximumBottom(undefined);
    test.layout.contentChanged();
    test.work.flushFrame();
    test.work.flushFrame();
    test.work.flushFrame();
    expect(test.rect.height).toBeGreaterThan(initialPageHeight * zoom);
    expect(test.rect.height).toBeLessThan(grownPageHeight * zoom);

    test.layout.interruptForInput();

    expect(test.setPage).toHaveBeenLastCalledWith(page(), initialPageHeight);
    expect(test.rect.height).toBeCloseTo(initialPageHeight * zoom);
    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(false);
    test.layout.dispose();
  });
});

function pageTransitionSizes(initialHeight: number) {
  return {
    grownPageHeight: derivePageExtent(page(), 500).activeHeight,
    initialHeight,
    initialPageHeight: derivePageExtent(page(), null).activeHeight,
    zoom: 1_000 / PAGE_WIDTH,
  };
}

function exerciseGrowth(
  test: ReturnType<typeof harness>,
  sizes: ReturnType<typeof pageTransitionSizes>,
): void {
  test.invalidateLayout.mockClear();
  test.setScenePending(true);
  test.setMaximumBottom(500);
  test.layout.contentChanged();
  test.work.flushFrame();

  expect(test.setPage).toHaveBeenLastCalledWith(page(), sizes.grownPageHeight);
  expect(test.rect.height).toBeCloseTo(sizes.initialHeight);
  expect(test.work.frames.size).toBe(0);
  expect(test.styleProperties.get("--inkbook-page-height-envelope-block-size")).toBe(
    `${String(sizes.grownPageHeight * sizes.zoom)}px`,
  );
  test.setScenePending(false);
  test.layout.sceneCommitted();
  test.work.flushFrame();
  expect(test.rect.height).toBeCloseTo(sizes.initialHeight);
  test.work.flushFrame();
  expect(test.rect.height).toBeGreaterThan(sizes.initialHeight);
  expect(test.rect.height).toBeLessThan(sizes.grownPageHeight * sizes.zoom);
  test.work.flushFrames();
  expect(test.rect.height).toBeCloseTo(sizes.grownPageHeight * sizes.zoom);
  expect(test.invalidateLayout).toHaveBeenCalledWith("coverage");
  expect(test.invalidateLayout).not.toHaveBeenCalledWith("clip");
}

function exerciseShrink(
  test: ReturnType<typeof harness>,
  sizes: ReturnType<typeof pageTransitionSizes>,
): void {
  test.invalidateLayout.mockClear();
  test.setPageChangesBecomePending(true);
  test.setMaximumBottom(undefined);
  test.layout.contentChanged();
  test.work.flushFrame();
  expect(test.setPage).toHaveBeenLastCalledWith(page(), sizes.grownPageHeight);
  expect(test.rect.height).toBeCloseTo(sizes.grownPageHeight * sizes.zoom);
  test.work.flushFrame();
  expect(test.rect.height).toBeCloseTo(sizes.grownPageHeight * sizes.zoom);
  test.work.flushFrame();
  expect(test.rect.height).toBeLessThan(sizes.grownPageHeight * sizes.zoom);
  expect(test.rect.height).toBeGreaterThan(sizes.initialPageHeight * sizes.zoom);
  test.work.flushFrames();
  expect(test.setPage).toHaveBeenLastCalledWith(page(), sizes.initialPageHeight);
  expect(test.rect.height).toBeGreaterThan(sizes.initialHeight);
  expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(true);
  test.setScenePending(false);
  test.layout.sceneCommitted();
  expect(test.rect.height).toBeCloseTo(sizes.initialHeight);
  expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(false);
  expect(test.invalidateLayout).toHaveBeenCalledWith("clip");
}

function runningHeightTransition(motion: "full" | "system") {
  const test = harness(motion);
  test.layout.chromeMounted();
  test.work.flushFrames();
  test.layout.beginSelectionEdgeDrag();
  test.layout.setSelectionBottomEdge(true);
  expect(test.work.frames.size).toBe(1);
  expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(true);
  return test;
}

function expectSettledTransition(
  test: ReturnType<typeof harness>,
  targetPageHeight: number,
  zoom: number,
): void {
  expect(test.setPage).toHaveBeenLastCalledWith(page(), targetPageHeight);
  expect(test.rect.height).toBeCloseTo(targetPageHeight * zoom);
  expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(false);
  test.layout.dispose();
}
