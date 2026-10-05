import { describe, expect, it } from "vitest";

import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { layoutHarness } from "../../integration/obsidian/embeds/active-editor-layout-fixture";
import { ownZoomResizeFixture } from "../../fixtures/obsidian/own-zoom-resize";

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz layout profile`, () => {
  it("validates each own projected observer report once without invalidating a second scene frame", () => {
    const { h, zoom, notify, reset, read, box, ownerBox } = ownZoomResizeFixture();
    reset();
    for (let index = 0; index < INTERACTION_REFRESH_PROFILE.sampleCount; index += 1) {
      const height = index % 2 === 0 ? 200 : 100;
      zoom(height);
      notify(height + 40);
    }
    const count = INTERACTION_REFRESH_PROFILE.sampleCount;
    expect(h.invalidateLayout).toHaveBeenCalledTimes(count);
    expect(read).toHaveBeenCalledTimes(count * 2);
    expect(box).toHaveBeenCalledTimes(count * 2);
    expect(ownerBox).toHaveBeenCalledTimes(count * 2);
    expect(h.work.frames.size).toBe(0);
    h.layout.dispose();
  });
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
