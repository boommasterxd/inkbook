import { describe, expect, it } from "vitest";

import { derivePageExtent, PAGE_WIDTH } from "../../../../../src/domain/geometry/public";
import { EVERY_BACKGROUND } from "../../../../fixtures/backgrounds";
import { layoutHarness as harness, page } from "./layout/active-editor-layout-fixture";

describe("active editor background preview layout", () => {
  it("previews every pattern and spacing without resizing the scene or container", () => {
    const test = harness("full");
    test.layout.chromeMounted();
    test.work.flushFrames();
    const initialHeight = derivePageExtent(page(), null).activeHeight;
    const initialRenderedHeight = (1_000 / PAGE_WIDTH) * initialHeight;

    for (const background of EVERY_BACKGROUND) {
      const preview = { ...page(), background };
      test.setPage.mockClear();

      test.layout.previewPage(preview);

      expect(test.setPage).toHaveBeenLastCalledWith(preview, initialHeight);
      expect(test.rendererPageHeight()).toBe(initialHeight);
      expect(test.rect.height).toBeCloseTo(initialRenderedHeight);
    }
    expect(test.beginScrollStability).not.toHaveBeenCalled();
    expect(test.releaseScrollStability).not.toHaveBeenCalled();
    test.layout.dispose();
  });

  it("restores a rejected preview without resizing", () => {
    const test = harness("full");
    test.layout.chromeMounted();
    test.work.flushFrames();
    const initialHeight = derivePageExtent(page(), null).activeHeight;
    const preview = {
      ...page(),
      background: { spacing: 100 as const, type: "dots" as const },
    };

    test.layout.previewPage(preview);
    test.layout.finishPagePreview(false);

    expect(test.setPage).toHaveBeenLastCalledWith(page(), initialHeight);
    expect(test.rect.height).toBeCloseTo((1_000 / PAGE_WIDTH) * initialHeight);
    expect(test.beginScrollStability).not.toHaveBeenCalled();
    test.layout.dispose();
  });

  it("keeps rapid spacing retargets atomic and height-invariant", () => {
    const test = harness("full");
    test.layout.chromeMounted();
    test.work.flushFrames();
    const initialHeight = derivePageExtent(page(), null).activeHeight;

    for (const spacing of [100, 25, 50, 33.333333333333336] as const) {
      const preview = {
        ...page(),
        background: { spacing, type: "lines" as const },
      };
      test.layout.previewPage(preview);
      expect(test.rendererPageHeight()).toBe(initialHeight);
      expect(derivePageExtent(preview, null).activeHeight).toBe(initialHeight);
    }

    expect(test.beginScrollStability).not.toHaveBeenCalled();
    expect(test.work.frames.size).toBe(0);
    test.layout.dispose();
  });
});
