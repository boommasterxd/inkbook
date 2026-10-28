// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { Platform } from "obsidian";
import { expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import {
  createPhoneSheetEditableFixture,
  installKeyboardInsetObserver,
} from "../../../fixtures/obsidian/phone-sheet-editable";
import {
  INTERACTION_REFRESH_PROFILE,
  runInteractionFrames,
} from "../../interaction-refresh-profile";

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

it("bounds focused-field reads across viewport retargets and performs one final correction", async () => {
  installObsidianDomHelpers();
  Platform.isPhone = true;
  vi.useFakeTimers();
  const fixture = createPhoneSheetEditableFixture(false, "full");
  try {
    for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
      fixture.viewport.height = frame % 2 === 0 ? 300 : 400;
      for (let event = 0; event < 3; event += 1)
        fixture.viewport.dispatchEvent(new Event("resize"));
      expect(fixture.frames.pendingCount).toBe(1);
      fixture.frames.runNext(0);
      await fixture.advanceMotion(INTERACTION_REFRESH_PROFILE.frameDurationMs);
    }
    expect(fixture.inputReadCount).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(fixture.scrollReadCount).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    await fixture.advanceMotion(300);
    expect(fixture.frames.pendingCount).toBe(1);
    fixture.frames.runNext(0);
    expect(fixture.inputReadCount).toBe(INTERACTION_REFRESH_PROFILE.sampleCount + 1);
    expect(fixture.scrollReadCount).toBe(INTERACTION_REFRESH_PROFILE.sampleCount + 1);
    expect(fixture.frames.pendingCount).toBe(0);
    fixture.session.close("immediate");
    await fixture.advanceMotion(300);
    expect(fixture.frames.pendingCount).toBe(0);
    expect(fixture.inputReadCount).toBe(INTERACTION_REFRESH_PROFILE.sampleCount + 1);
  } finally {
    try {
      fixture.session.close("immediate");
    } finally {
      fixture.restore();
      vi.restoreAllMocks();
      vi.useRealTimers();
      Platform.isPhone = false;
      document.body.replaceChildren();
    }
  }
});
