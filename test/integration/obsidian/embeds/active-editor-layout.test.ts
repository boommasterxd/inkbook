import { describe, expect, it } from "vitest";

import { derivePageExtent, PAGE_WIDTH } from "../../../../src/domain/geometry/public";
import { layoutHarness as harness, page } from "./active-editor-layout-fixture";

describe("active editor layout integration", () => {
  it("refreshes page paint when the background changes without changing page height", () => {
    const test = harness("full");
    const dots = { ...page(), background: { spacing: 50 as const, type: "dots" as const } };
    test.setDocumentPage(dots);
    test.layout.chromeMounted();
    test.work.flushFrames();
    test.setPage.mockClear();
    const squares = {
      ...dots,
      background: { spacing: 50 as const, type: "squares" as const },
    };

    test.setDocumentPage(squares);
    test.layout.pageChanged();

    expect(test.setPage).toHaveBeenCalledWith(
      squares,
      derivePageExtent(squares, null).activeHeight,
    );
    test.work.flushFrames();
    test.layout.dispose();
  });

  it("requests one viewport layout refresh when the presentation size changes", () => {
    const test = harness("full");
    test.invalidateLayout.mockClear();

    test.triggerResize();

    expect(test.invalidateLayout).toHaveBeenCalledWith();
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

  it("keeps the canvas extent stable until committed content requires growth", () => {
    const test = harness();
    test.layout.chromeMounted();
    test.work.flushFrames();
    const originalHeight = test.rect.height;

    test.layout.contentChanged();
    test.work.flushFrames();
    expect(test.rect.height).toBeCloseTo(originalHeight);
    expect(test.beginScrollStability).not.toHaveBeenCalled();
    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(false);

    test.setMaximumBottom(225);
    test.layout.contentChanged();
    test.work.flushFrames();
    expect(test.rect.height).toBeGreaterThan(originalHeight);
    expect(test.beginScrollStability).toHaveBeenCalledOnce();
    expect(test.releaseScrollStability).toHaveBeenCalledOnce();
    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(false);
    test.layout.dispose();
  });

  it("animates selection-move growth without fighting the active scroll gesture", () => {
    const test = harness();
    test.layout.chromeMounted();
    test.work.flushFrames();
    const originalHeight = test.rect.height;
    const previewBottom = 925;

    test.layout.beginSelectionMove();
    test.layout.updateSelectionMoveBottom(previewBottom);

    expect(test.rect.height).toBeCloseTo(originalHeight);
    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(true);
    test.work.flushFrames();
    expect(test.rect.height).toBeCloseTo(
      derivePageExtent(page(), previewBottom).activeHeight * (1_000 / PAGE_WIDTH),
    );
    expect(test.rect.height).toBeGreaterThan(originalHeight);
    expect(test.beginScrollStability).not.toHaveBeenCalled();
    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(false);

    test.layout.finishSelectionMove(true, previewBottom);
    expect(test.rect.height).toBeCloseTo(
      derivePageExtent(page(), previewBottom).activeHeight * (1_000 / PAGE_WIDTH),
    );
    expect(test.beginScrollStability).not.toHaveBeenCalled();
    test.layout.dispose();
  });
});

describe("active editor selection-move layout", () => {
  it("does not collapse a selection reservation during a resize-observer measurement", () => {
    const test = harness();
    test.layout.chromeMounted();
    test.work.flushFrames();
    const previewBottom = 925;

    test.layout.beginSelectionMove();
    test.layout.updateSelectionMoveBottom(previewBottom);
    test.work.flushFrames();
    const reservedHeight = test.rect.height;
    test.layout.contentChanged();
    test.work.flushFrames();

    expect(test.rect.height).toBeCloseTo(reservedHeight);
    expect(test.layout.currentPageHeight()).toBe(
      derivePageExtent(page(), previewBottom).activeHeight,
    );
    expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(false);
    test.layout.finishSelectionMove(false);
    test.layout.dispose();
  });
});

describe("active editor layout sizing stability", () => {
  it("does not acquire scroll stability for repeated unchanged layout frames", () => {
    const test = harness("reduced");
    test.layout.chromeMounted();
    test.work.flushFrames();
    const originalHeight = test.rect.height;

    test.layout.contentChanged();
    test.layout.contentChanged();
    test.work.flushFrames();

    expect(test.rect.height).toBeCloseTo(originalHeight);
    expect(test.beginScrollStability).not.toHaveBeenCalled();
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
    expect(test.beginScrollStability).toHaveBeenCalledOnce();
    expect(test.releaseScrollStability).toHaveBeenCalledOnce();
    exerciseShrink(test, sizes);
    expect(test.beginScrollStability).toHaveBeenCalledTimes(2);
    expect(test.releaseScrollStability).toHaveBeenCalledTimes(2);
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

    expect(test.rendererPageHeight()).toBeCloseTo(grownPageHeight);
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
    const requiredPageHeight = derivePageExtent(page(), 500).activeHeight;
    test.setScenePending(true);
    test.setMaximumBottom(500);
    test.layout.contentChanged();
    test.work.flushFrame();

    test.layout.interruptForInput();

    expect(test.rect.height).toBeCloseTo(initialHeight);
    expect(test.setPage).toHaveBeenLastCalledWith(page(), requiredPageHeight);
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

  it("commits reduced-motion height without redundant camera or scroll writes", () => {
    const test = harness("reduced");
    test.layout.chromeMounted();
    test.work.flushFrames();
    test.onResize.mockClear();
    test.setMaximumBottom(225);
    test.layout.contentChanged();
    test.work.flushFrames();

    expect(test.onResize).not.toHaveBeenCalled();
    expect(test.invalidateLayout.mock.calls.length).toBeGreaterThan(0);
    test.layout.dispose();
  });

  it("finishes automatic height motion before a new input gesture proceeds", () => {
    const test = runningHeightTransition("full");
    const targetPageHeight = derivePageExtent(page(), 225).activeHeight;
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
    const targetPageHeight = derivePageExtent(page(), 225).activeHeight;
    const fitZoom = 1_000 / PAGE_WIDTH;
    const zoom = fitZoom * 1.5;

    test.work.flushFrame();
    test.work.flushFrame();
    test.layout.applyZoom({ blockSize: targetPageHeight * zoom, zoom });

    expectSettledTransition(test, targetPageHeight, zoom);
  });

  it("keeps the larger safe surface until an interrupted deletion shrink is remeasured", () => {
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

    expect(test.setPage).toHaveBeenLastCalledWith(page(), grownPageHeight);
    expect(test.rect.height).toBeCloseTo(grownPageHeight * zoom);
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
  expect(test.invalidateLayout).toHaveBeenCalledWith();
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
  expect(test.rendererPageHeight()).toBeCloseTo(sizes.grownPageHeight);
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
  expect(test.invalidateLayout).toHaveBeenCalledWith();
}

function runningHeightTransition(motion: "full" | "system") {
  const test = harness(motion);
  test.layout.chromeMounted();
  test.work.flushFrames();
  test.setMaximumBottom(225);
  test.layout.contentChanged();
  test.work.flushFrame();
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
