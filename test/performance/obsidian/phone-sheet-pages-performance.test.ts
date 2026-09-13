// @vitest-environment happy-dom

import { expect, it } from "vitest";
import { PhoneSheetPages } from "../../../src/obsidian/menus/phone-sheet-pages";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import { interactionP99, measureInteractionFrames } from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";

it("swaps and restores a phone sheet page within the strictest frame budget", async ({
  annotate,
}) => {
  installObsidianDomHelpers();
  const layer = window.createDiv();
  const surface = layer.createEl("section");
  const scroll = surface.createDiv();
  const rootContent = scroll.createDiv();
  rootContent.createEl("button", { text: "Settings" });
  document.body.append(layer);
  let disposed = 0;
  const pages = new PhoneSheetPages({
    layer,
    surface,
    scroll,
    rootContent,
    ownerWindow: window,
    lifecycle: { prepareLayoutChange: () => undefined, requestLayout: () => undefined },
    position: () => undefined,
    maximumHeight: () => 464,
    renderIcon: () => undefined,
    observeContent: () => undefined,
    durationMs: 220,
    pageDurationMs: 220,
    close: () => undefined,
  });
  try {
    const durations = measureInteractionFrames((frame) => {
      if (frame % 2 === 1) {
        pages.back();
        return;
      }
      pages.push({
        kind: "dialog",
        label: "Settings",
        createContent: () => {
          const fragment = window.createFragment();
          for (let index = 0; index < 12; index += 1) {
            const row = window.createDiv();
            row.createEl("label", { text: `Preference ${String(index)}` });
            row.createEl("input", { type: "number" });
            fragment.append(row);
          }
          return fragment;
        },
        dispose: () => {
          disposed += 1;
        },
      });
    });
    const p99 = interactionP99(durations);
    expect(p99).toBeLessThanOrEqual(timingBudget((1000 / 240) * 0.55));
    expect(disposed).toBe(durations.length / 2);
    expect(scroll.children).toHaveLength(1);
    expect(scroll.firstElementChild).toBe(rootContent);
    await annotate(`Phone sheet push/back p99=${p99.toFixed(3)} ms; 240 Hz budget`, "performance");
  } finally {
    pages.dispose();
    layer.remove();
  }
});
