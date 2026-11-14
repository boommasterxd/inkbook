import { expect, it } from "vitest";
import { derivePageExtent } from "../../../../../../src/domain/geometry/public";
import { layoutHarness, page } from "./active-editor-layout-fixture";

it.each([false, true])(
  "keeps source growth owned after an interrupted nested resize (committed=%s)",
  (committed) => {
    const test = layoutHarness();
    test.layout.chromeMounted();
    test.work.flushFrames();
    const original = test.layout.currentPageHeight();
    test.layout.beginSelectionMove();
    test.layout.updateSelectionMoveBottom(925);
    test.work.flushFrames();
    test.layout.beginSelectionMove();
    test.layout.updateSelectionMoveBottom(1525);
    test.layout.interruptForInput();
    if (committed) test.setMaximumBottom(525);
    test.layout.finishSelectionMove(committed);
    test.layout.contentChanged();
    test.work.flushFrames();
    const before = test.layout.currentPageHeight()!;
    test.layout.updateSelectionMoveBottom(2525);
    test.work.flushFrames();
    expect(test.layout.currentPageHeight()).toBeGreaterThan(before);
    expect(test.beginScrollStability).not.toHaveBeenCalled();
    test.layout.finishSelectionMove(false);
    test.work.flushFrames();
    expect(test.layout.currentPageHeight()).toBe(
      committed ? derivePageExtent(page(), 525).activeHeight : original,
    );
    expect(test.beginScrollStability).toHaveBeenCalledOnce();
    expect(test.releaseScrollStability).toHaveBeenCalledOnce();
    test.layout.beginSelectionMove();
    test.layout.beginSelectionMove();
    test.layout.updateSelectionMoveBottom(3525);
    test.layout.dispose();
    test.layout.finishSelectionMove(false);
    test.layout.finishSelectionMove(false);
    test.layout.contentChanged();
    expect(test.work.frames.size).toBe(0);
  },
);

it("corrects temporary source-gap overshoots without shrinking another active gesture's reservation", () => {
  const test = layoutHarness();
  test.layout.chromeMounted();
  test.work.flushFrames();
  const original = test.layout.currentPageHeight()!;
  test.layout.beginSelectionMove();
  test.layout.updateSelectionMoveBottom(198_789, false, true);
  test.layout.updateSelectionMoveBottom(933.094, false, true);
  const corrected = Math.max(original, derivePageExtent(page(), 933.094).activeHeight);
  expect(test.layout.currentPageHeight()).toBe(corrected);
  test.work.flushFrames();
  expect(test.layout.currentPageHeight()).toBe(corrected);
  test.layout.beginSelectionMove();
  test.layout.updateSelectionMoveBottom(198_789);
  test.layout.updateSelectionMoveBottom(933.094, false, true);
  expect(test.layout.currentPageHeight()).toBeGreaterThan(corrected);
  test.layout.finishSelectionMove(false);
  test.layout.updateSelectionMoveBottom(933.094, true, true);
  expect(test.layout.currentPageHeight()).toBe(corrected);
  test.work.flushFrames();
  expect(test.layout.currentPageHeight()).toBe(corrected);
  test.layout.finishSelectionMove(false);
  test.work.flushFrames();
  expect(test.layout.currentPageHeight()).toBe(original);
  test.layout.dispose();
  expect(test.work.frames.size).toBe(0);
});

it("keeps source shrink above connected geometry committed by an inner resize", () => {
  const test = layoutHarness();
  test.layout.chromeMounted();
  test.work.flushFrames();
  test.layout.beginSelectionMove();
  test.layout.updateSelectionMoveBottom(198_789, false, true);
  test.layout.beginSelectionMove();
  test.setMaximumBottom(4000);
  test.layout.finishSelectionMove(true, 4000);
  test.layout.updateSelectionMoveBottom(933.094, false, true);
  const required = derivePageExtent(page(), 4000).activeHeight;
  expect(test.layout.currentPageHeight()).toBe(required);
  expect(test.setPage.mock.lastCall?.[1]).toBe(required);
  test.work.flushFrames();
  expect(test.layout.currentPageHeight()).toBe(required);
  test.layout.finishSelectionMove(false);
  test.work.flushFrames();
  expect(test.layout.currentPageHeight()).toBe(required);
  test.layout.dispose();
});
