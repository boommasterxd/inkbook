// @vitest-environment happy-dom

import { Platform } from "obsidian";
import { expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import { createPhoneSheetEditableFixture } from "../../fixtures/obsidian/phone-sheet-editable";
import { interactionP99, measureInteractionFrames } from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";

it("coalesces viewport correction with two geometry reads inside the 240 Hz frame budget", () => {
  installObsidianDomHelpers();
  Platform.isPhone = true;
  const fixture = createPhoneSheetEditableFixture();
  try {
    const durations = measureInteractionFrames(() => {
      fixture.scroll.scrollTop = 100;
      for (let event = 0; event < 3; event += 1)
        fixture.viewport.dispatchEvent(new Event("resize"));
      expect(fixture.frames.pendingCount).toBe(1);
      fixture.frames.runNext(0);
    });
    expect(fixture.inputRead).toHaveBeenCalledTimes(durations.length);
    expect(fixture.scrollRead).toHaveBeenCalledTimes(durations.length);
    expect(interactionP99(durations)).toBeLessThanOrEqual(timingBudget((1000 / 240) * 0.55));
  } finally {
    fixture.session.close("immediate");
    Platform.isPhone = false;
    document.body.replaceChildren();
    Reflect.deleteProperty(window, "visualViewport");
    vi.restoreAllMocks();
  }
});
