// @vitest-environment happy-dom

import { Platform } from "obsidian";
import { expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import {
  createPhoneSheetEditableFixture,
  installKeyboardInsetObserver,
} from "../../fixtures/obsidian/phone-sheet-editable";
import { INTERACTION_REFRESH_PROFILE, runInteractionFrames } from "../interaction-refresh-profile";

it("coalesces viewport correction with two geometry reads with bounded work", () => {
  installObsidianDomHelpers();
  Platform.isPhone = true;
  const inset = installKeyboardInsetObserver();
  const fixture = createPhoneSheetEditableFixture(false);
  const events = Array.from({ length: INTERACTION_REFRESH_PROFILE.sampleCount }, () =>
    Array.from({ length: 3 }, () => new Event("resize")),
  );
  let incorrectlyQueuedFrames = 0;
  try {
    runInteractionFrames((frame) => {
      fixture.scroll.scrollTop = 100;
      for (const event of events[frame]!) {
        fixture.viewport.dispatchEvent(event);
        inset.resize(350);
      }
      if (fixture.frames.pendingCount !== 1) incorrectlyQueuedFrames += 1;
      fixture.frames.runNext(0);
    });
    expect(incorrectlyQueuedFrames).toBe(0);
    expect(fixture.inputReadCount).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(fixture.scrollReadCount).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
  } finally {
    try {
      fixture.session.close("immediate");
    } finally {
      vi.restoreAllMocks();
      fixture.restore();
      Platform.isPhone = false;
      document.body.replaceChildren();
    }
  }
});
