// @vitest-environment happy-dom

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
  const layer = window.createDiv();
  const surface = layer.createEl("section");
  const scroll = surface.createDiv();
  const rootContent = scroll.createDiv();
  rootContent.createEl("button", { text: "Settings" });
  document.body.append(layer);
  let disposed = 0;
  let naturalHeight = 280;
  Object.defineProperty(scroll, "scrollHeight", { get: () => naturalHeight });
  scroll.getBoundingClientRect = () =>
    new DOMRect(0, 0, 360, Number.parseFloat(scroll.style.blockSize) || naturalHeight);
  const height = new AdaptivePanelHeight({
    scroll,
    surface,
    ownerWindow: window,
    maximumHeight: () => 464,
    durationMs: 220,
    pageDurationMs: 220,
  });
  const pages = new PhoneSheetPages({
    layer,
    surface,
    scroll,
    rootContent,
    lifecycle: { prepareLayoutChange: () => undefined, requestLayout: () => undefined },
    position: () => undefined,
    renderIcon: () => undefined,
    observeContent: () => undefined,
    height,
    close: () => undefined,
  });
  try {
    const durations = measureInteractionFrames((frame) => {
      if (frame % 2 === 1) {
        naturalHeight = 280;
        pages.back();
        return;
      }
      pages.push({
        kind: "dialog",
        label: "Settings",
        createContent: () => {
          naturalHeight = 600;
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
    expectTiming(p99, (1000 / 240) * 0.55);
    expect(disposed).toBe(durations.length / 2);
    expect(scroll.children).toHaveLength(1);
    expect(scroll.firstElementChild).toBe(rootContent);
    await annotate(`Phone sheet push/back p99=${p99.toFixed(3)} ms; 240 Hz budget`, "performance");
  } finally {
    height.dispose();
    pages.dispose();
    layer.remove();
  }
});
