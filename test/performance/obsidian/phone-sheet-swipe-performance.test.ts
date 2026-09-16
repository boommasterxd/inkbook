// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPhoneSheetSwipeHarness,
  touchPointer,
} from "../../fixtures/obsidian/phone-sheet-swipe";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  interactionProfileAnnotation,
  measureInteractionFrames,
} from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("phone sheet swipe performance", () => {
  it("coalesces continuous touch input without repeated layout reads", async ({ annotate }) => {
    installObsidianDomHelpers();
    const fixture = createPhoneSheetSwipeHarness();
    const { controller, frames } = fixture;
    const heightRead = vi.spyOn(fixture.surface, "getBoundingClientRect");
    fixture.handle.dispatchEvent(touchPointer("pointerdown", 10, 1, 0));

    const durations = measureInteractionFrames((frame) => {
      fixture.surface.dispatchEvent(touchPointer("pointermove", 10 + frame * 2, 1, frame + 1));
      fixture.surface.dispatchEvent(touchPointer("pointermove", 11 + frame * 2, 1, frame + 2));
      fixture.surface.dispatchEvent(touchPointer("pointermove", 12 + frame * 2, 1, frame + 3));
      frames.flush();
    });

    const p99 = interactionP99(durations);
    expect(heightRead).toHaveBeenCalledOnce();
    expect(frames.maxPending).toBe(1);
    expect(frames.pending).toBe(0);
    expect(fixture.dragWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(fixture.inheritedWrites).toBe(0);
    expect(fixture.surface.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(interactionProfileAnnotation("phone sheet swipe", p99), "performance");
    controller.dispose();
  });
});
