// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { expect, it } from "vitest";
import { AdaptivePanelLayout } from "../../../../src/obsidian/menus/panels/adaptive-panel-layout";
import { PhoneSheetPages } from "../../../../src/obsidian/menus/panels/phone-sheet-pages";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";

function createPhonePagePerformanceFixture() {
  const layer = window.createDiv();
  const surface = layer.createEl("section");
  const grabber = surface.createDiv();
  const scroll = surface.createDiv();
  const rootContent = scroll.createDiv();
  rootContent.createEl("button", { text: "Settings" });
  let disposed = 0;
  let created = 0;
  const layout = new AdaptivePanelLayout(surface, grabber, scroll);
  const pages = new PhoneSheetPages({
    layer,
    surface,
    scroll,
    rootContent,
    lifecycle: { mutateLayout: (update) => update() },
    position: () => undefined,
    renderIcon: () => undefined,
    observeContent: () => undefined,
    refreshFeedback: () => undefined,
    layout,
    durationMs: () => 220,
    pageDurationMs: () => 220,
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
      pages.back();
    },
    dispose() {
      pages.dispose();
      layout.dispose();
      layer.remove();
    },
  };
}

it("bounds retained page nodes throughout repeated push and back transitions", () => {
  installObsidianDomHelpers();
  const fixture = createPhonePagePerformanceFixture();
  document.body.append(fixture.layer);
  try {
    for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
      if (frame % 2 === 0) fixture.push();
      else fixture.back();
      // Inventory traversal belongs to the resource check, outside the transition itself.
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
