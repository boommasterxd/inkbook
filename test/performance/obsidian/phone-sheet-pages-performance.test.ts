// @vitest-environment happy-dom

import { createPhonePagePerformanceFixture } from "../../fixtures/obsidian/phone-sheet-page-performance";

import { expect, it } from "vitest";
import { AdaptivePanelHeight } from "../../../src/obsidian/menus/adaptive-panel-height";
import { PhoneSheetPages } from "../../../src/obsidian/menus/phone-sheet-pages";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import { interactionP99, measureInteractionFrames } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

it("swaps and restores a phone sheet page within the strictest frame budget", async ({
  annotate,
}) => {
  installObsidianDomHelpers();
  const fixture = createPhonePagePerformanceFixture({
    height: AdaptivePanelHeight,
    pages: PhoneSheetPages,
  });
  document.body.append(fixture.layer);
  try {
    const durations = measureInteractionFrames((frame) => {
      if (frame % 2 === 1) {
        fixture.back();
        return;
      }
      fixture.push();
    });
    const p99 = interactionP99(durations);
    expectTiming(p99, (1000 / 240) * 0.55);
    expect(fixture.disposed).toBe(durations.length / 2);
    expect(fixture.created).toBe(fixture.disposed);
    // One active 12-row page plus the retained root and navigation shell.
    expect(fixture.maximumNodes).toBeLessThanOrEqual(50);
    expect(fixture.scroll.children).toHaveLength(1);
    expect(fixture.scroll.firstElementChild).toBe(fixture.rootContent);
    await annotate(`Phone sheet push/back p99=${p99.toFixed(3)} ms; 240 Hz budget`, "performance");
  } finally {
    fixture.dispose();
  }
});
