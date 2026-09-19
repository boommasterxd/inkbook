// @vitest-environment happy-dom

import { expect, it } from "vitest";
import { AdaptivePanelHeight } from "../../../src/obsidian/menus/adaptive-panel-height";
import { PhoneSheetPages } from "../../../src/obsidian/menus/phone-sheet-pages";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import { INTERACTION_REFRESH_PROFILE, runInteractionFrames } from "../interaction-refresh-profile";

function createPhonePagePerformanceFixture() {
  const layer = window.createDiv();
  const surface = layer.createEl("section");
  const scroll = surface.createDiv();
  const rootContent = scroll.createDiv();
  rootContent.createEl("button", { text: "Settings" });
  let disposed = 0;
  let created = 0;
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

it("swaps and restores a phone sheet page without rebuilding controls", () => {
  installObsidianDomHelpers();
  const fixture = createPhonePagePerformanceFixture();
  document.body.append(fixture.layer);
  try {
    runInteractionFrames((frame) => {
      if (frame % 2 === 1) {
        fixture.back();
        return;
      }
      fixture.push();
    });

    expect(fixture.disposed).toBe(INTERACTION_REFRESH_PROFILE.sampleCount / 2);
    expect(fixture.created).toBe(fixture.disposed);
    expect(fixture.scroll.children).toHaveLength(1);
    expect(fixture.scroll.firstElementChild).toBe(fixture.rootContent);
  } finally {
    fixture.dispose();
  }
});

it("bounds retained page nodes throughout repeated push and back transitions", () => {
  installObsidianDomHelpers();
  const fixture = createPhonePagePerformanceFixture();
  document.body.append(fixture.layer);
  try {
    for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
      if (frame % 2 === 0) fixture.push();
      else fixture.back();
      // Inventory traversal belongs to the resource check, outside the timed trajectory.
      expect(fixture.layer.querySelectorAll("*").length).toBeLessThanOrEqual(50);
    }
    expect(fixture.created).toBe(INTERACTION_REFRESH_PROFILE.sampleCount / 2);
    expect(fixture.disposed).toBe(fixture.created);
    expect(fixture.scroll.children).toHaveLength(1);
    expect(fixture.scroll.firstElementChild).toBe(fixture.rootContent);
  } finally {
    fixture.dispose();
  }
});
