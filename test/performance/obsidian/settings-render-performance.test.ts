// @vitest-environment happy-dom

import type { App, Plugin } from "obsidian";
import { expect, it, vi } from "vitest";
import { InkbookSettingTab } from "../../../src/obsidian/settings/setting-tab";
import { SettingsModalContent } from "../../../src/obsidian/settings/settings-modal-content";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import { createTestSettingsStore } from "../../fixtures/obsidian/settings-store";
import { interactionP99, measureInteractionFrames } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

it("keeps unopened settings bounded and unrelated device changes within the strictest frame budget", async ({
  annotate,
}) => {
  installObsidianDomHelpers();
  const container = document.body.createDiv();
  const app = { workspace: { containerEl: container } } as unknown as App;
  const store = createTestSettingsStore();
  const content = new SettingsModalContent(container, {
    app,
    settingTab: new InkbookSettingTab(app, {} as Plugin, store),
    store,
    view: "settings",
  });
  try {
    expect(
      container.querySelectorAll(".inkbook-settings-tool-controls [data-control]"),
    ).toHaveLength(0);
    // Bounds the real settings tree, including all still-collapsed tool and shortcut sections.
    expect(container.querySelectorAll("*").length).toBeLessThan(800);
    const shortcuts = container.querySelector<HTMLElement>(".inkbook-shortcuts-view");
    if (shortcuts === null) throw new Error("Missing shortcut view");
    const replace = vi.spyOn(shortcuts, "replaceChildren");
    const initialNodes = [...container.querySelectorAll("*")];
    const create = vi.spyOn(document, "createElementNS");
    const durations = measureInteractionFrames((frame) => {
      store.updateDeviceSettings((settings) => ({
        ...settings,
        motion: frame % 2 === 0 ? "reduced" : "full",
      }));
    });
    expect(replace).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect([...container.querySelectorAll("*")]).toEqual(initialNodes);
    const p99 = interactionP99(durations);
    expectTiming(p99, (1000 / 240) * 0.55);
    await annotate(
      `Unrelated settings change p99=${p99.toFixed(3)} ms; 240 Hz budget`,
      "performance",
    );
  } finally {
    content.dispose();
    container.remove();
    vi.restoreAllMocks();
  }
});
