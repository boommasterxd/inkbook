// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPhoneSheetSwipeHarness,
  touchPointer,
} from "../../fixtures/obsidian/phone-sheet-swipe";
import { INTERACTION_REFRESH_PROFILE, runInteractionFrames } from "../interaction-refresh-profile";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("phone sheet swipe performance", () => {
  it("coalesces continuous touch input without repeated layout reads", () => {
    installObsidianDomHelpers();
    const fixture = createPhoneSheetSwipeHarness(0, false);
    const { controller, frames } = fixture;
    try {
      const heightRead = vi.spyOn(fixture.surface, "getBoundingClientRect");
      const events = Array.from({ length: INTERACTION_REFRESH_PROFILE.sampleCount }, (_, frame) => [
        touchPointer("pointermove", 10 + frame * 2, 1, frame + 1),
        touchPointer("pointermove", 11 + frame * 2, 1, frame + 2),
        touchPointer("pointermove", 12 + frame * 2, 1, frame + 3),
      ]);
      fixture.handle.dispatchEvent(touchPointer("pointerdown", 10, 1, 0));

      runInteractionFrames((frame) => {
        for (const event of events[frame]!) fixture.surface.dispatchEvent(event);
        frames.flush();
      });

      expect(heightRead).toHaveBeenCalledOnce();
      expect(frames.maxPending).toBe(1);
      expect(frames.pending).toBe(0);
      expect(fixture.dragWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
      expect(fixture.inheritedWrites).toBe(0);
      expect(fixture.surface.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");
    } finally {
      try {
        controller.dispose();
      } finally {
        fixture.restore();
      }
    }
  });
});
