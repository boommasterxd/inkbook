import { describe, expect, it } from "vitest";

import { derivePageExtent, PAGE_WIDTH } from "../../../../src/domain/geometry/public";
import { layoutHarness, page } from "./active-editor-layout-fixture";

describe("active editor border height", () => {
  it.each([2, 4.5])("preserves the complete page inside %s pixels of block insets", (insets) => {
    const test = layoutHarness("full", 4, insets);
    test.layout.chromeMounted();
    test.work.flushFrames();
    const height = derivePageExtent(page(), null).activeHeight;
    const zoom = 996 / PAGE_WIDTH;
    expect(test.rect.height).toBeCloseTo(height * zoom + insets);

    test.layout.applyZoom({ blockSize: height * zoom * 2, zoom: zoom * 2 });
    expect(test.rect.height).toBeCloseTo(height * zoom * 2 + insets);

    test.rect.width = 804;
    test.triggerResize();
    test.work.flushFrames();
    expect(test.rect.height).toBeCloseTo(height * (800 / PAGE_WIDTH) * 2 + insets);
    test.layout.dispose();
  });

  it("retains border height through page growth and interrupted transitions", () => {
    const test = layoutHarness("full", 4, 2);
    test.layout.chromeMounted();
    test.work.flushFrames();
    const zoom = 996 / PAGE_WIDTH;
    test.setMaximumBottom(1_000);
    test.layout.contentChanged();
    test.work.flushFrame();
    const targetHeight = derivePageExtent(page(), 1_000).activeHeight;
    expect(
      Number.parseFloat(test.styleProperties.get("--inkbook-page-height-envelope-block-size")!),
    ).toBeCloseTo(targetHeight * zoom + 2);
    test.work.flushFrames();
    expect(test.rect.height).toBeCloseTo(targetHeight * zoom + 2);

    test.setMaximumBottom(2_000);
    test.layout.contentChanged();
    test.work.flushFrame();
    test.layout.interruptForInput();
    test.work.flushFrames();
    expect(test.rect.height).toBeCloseTo(derivePageExtent(page(), 2_000).activeHeight * zoom + 2);
    test.layout.dispose();
  });
});
