import { describe, expect, it } from "vitest";

import { derivePageExtent, PAGE_WIDTH } from "../../../../src/domain/geometry/public";
import { layoutHarness, page } from "./active-editor-layout-fixture";

describe("active editor zoom extent synchronization", () => {
  it.each(["full", "reduced"] as const)(
    "keeps the background and container aligned when zoom overtakes committed growth with %s motion",
    (motion) => {
      const test = layoutHarness(motion);
      const fitZoom = 1_000 / PAGE_WIDTH;
      const originalHeight = derivePageExtent(page(), null).activeHeight;
      const grownHeight = derivePageExtent(page(), 500).activeHeight;
      test.layout.chromeMounted();
      test.work.flushFrames();
      test.layout.applyZoom({ blockSize: originalHeight * fitZoom * 4, zoom: fitZoom * 4 });
      test.setPage.mockClear();

      test.setMaximumBottom(500);
      test.layout.contentChanged();
      test.layout.applyZoom({ blockSize: originalHeight * fitZoom * 2, zoom: fitZoom * 2 });
      expect(test.rendererPageHeight()).toBe(grownHeight);
      expect(test.rect.height).toBeCloseTo(grownHeight * fitZoom * 2);
      expect(test.setPage).toHaveBeenCalledOnce();
      test.work.flushFrames();
      test.layout.applyZoom({
        blockSize: test.layout.currentPageHeight()! * fitZoom,
        zoom: fitZoom,
      });
      test.work.flushFrames();

      expect(test.layout.currentPageHeight()).toBe(grownHeight);
      expect(test.rendererPageHeight()).toBe(grownHeight);
      expect(test.rect.height).toBeCloseTo(grownHeight * fitZoom);
      expect(test.setPage).toHaveBeenCalledOnce();
      expect(test.classList.contains("inkbook-page-height-transitioning")).toBe(false);
      test.layout.dispose();
    },
  );
});
