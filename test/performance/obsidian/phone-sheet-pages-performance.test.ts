// @vitest-environment happy-dom

import { expect, it } from "vitest";
import { AdaptivePanelHeight } from "../../../src/obsidian/menus/adaptive-panel-height";
import { PhoneSheetPages } from "../../../src/obsidian/menus/phone-sheet-pages";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import { interactionP99, measureInteractionFrames } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

/** Full page fixture; callers select implementations and retain their measurement boundaries. */
function createPhonePagePerformanceFixture(constructors: {
  height: typeof AdaptivePanelHeight;
  pages: typeof PhoneSheetPages;
}) {
  const layer = window.createDiv();
  const surface = layer.createEl("section");
  const scroll = surface.createDiv();
  const rootContent = scroll.createDiv();
  rootContent.createEl("button", { text: "Settings" });
  let disposed = 0;
  let created = 0;
  let maximumNodes = 0;
  let naturalHeight = 280;
  Object.defineProperty(scroll, "scrollHeight", { get: () => naturalHeight });
  scroll.getBoundingClientRect = () =>
    new DOMRect(0, 0, 360, Number.parseFloat(scroll.style.blockSize) || naturalHeight);
  const height = new constructors.height({
    scroll,
    surface,
    ownerWindow: window,
    maximumHeight: () => 464,
    durationMs: 220,
    pageDurationMs: 220,
  });
  const pages = new constructors.pages({
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
  return {
    layer,
    scroll,
    rootContent,
    get disposed() {
      return disposed;
    },
    get created() {
      return created;
    },
    get maximumNodes() {
      return maximumNodes;
    },
    resetCounts() {
      created = 0;
      disposed = 0;
      maximumNodes = 0;
    },
    push() {
      pages.push({
        kind: "dialog",
        label: "Settings",
        createContent: () => {
          created += 1;
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
      maximumNodes = Math.max(maximumNodes, layer.querySelectorAll("*").length);
    },
    back() {
      naturalHeight = 280;
      pages.back();
    },
    dispose() {
      height.dispose();
      pages.dispose();
      layer.remove();
    },
  };
}

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
