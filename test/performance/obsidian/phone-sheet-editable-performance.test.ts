// @vitest-environment happy-dom

import { Platform } from "obsidian";
import { expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import {
  createPhoneSheetEditableFixture,
  installKeyboardInsetObserver,
} from "../../fixtures/obsidian/phone-sheet-editable";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  measureInteractionFrames,
} from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

it("coalesces viewport correction with two geometry reads inside the 240 Hz frame budget", () => {
  installObsidianDomHelpers();
  Platform.isPhone = true;
  const inset = installKeyboardInsetObserver();
  const fixture = createPhoneSheetEditableFixture(false);
  const events = Array.from({ length: INTERACTION_REFRESH_PROFILE.sampleCount }, () =>
    Array.from({ length: 3 }, () => new Event("resize")),
  );
  let incorrectlyQueuedFrames = 0;
  try {
    const durations = measureInteractionFrames((frame) => {
      fixture.scroll.scrollTop = 100;
      for (const event of events[frame]!) {
        fixture.viewport.dispatchEvent(event);
        inset.resize(350);
      }
      if (fixture.frames.pendingCount !== 1) incorrectlyQueuedFrames += 1;
      fixture.frames.runNext(0);
    });
    expect(incorrectlyQueuedFrames).toBe(0);
    expect(fixture.inputReadCount).toBe(durations.length);
    expect(fixture.scrollReadCount).toBe(durations.length);
    expectTiming(interactionP99(durations), (1000 / 240) * 0.55);
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
