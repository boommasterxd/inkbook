import { describe, expect, it } from "vitest";

import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { layoutHarness } from "../../integration/obsidian/embeds/active-editor-layout-fixture";

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz layout profile`, () => {
  it("keeps settled page geometry out of continuous zoom layout work", () => {
    const harness = layoutHarness("reduced");
    harness.layout.chromeMounted();
    harness.work.flushFrames();
    harness.setMaximumBottom(5_000);
    harness.layout.contentChanged();
    harness.work.flushFrames();
    const pageHeight = harness.layout.currentPageHeight()!;
    const pageWrites = harness.setPage.mock.calls.length;
    harness.invalidateLayout.mockClear();

    for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
      const zoom = frame % 2 === 0 ? 2 : 4;
      harness.layout.applyZoom({ blockSize: pageHeight * zoom, zoom });
    }

    expect(harness.setPage).toHaveBeenCalledTimes(pageWrites);
    expect(harness.invalidateLayout).toHaveBeenCalledTimes(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.rendererPageHeight()).toBe(pageHeight);
    expect(harness.rect.height).toBeCloseTo(pageHeight * 4);
    expect(harness.work.frames.size).toBe(0);
    harness.layout.dispose();
    expect(harness.work.frames.size).toBe(0);
  });
});
