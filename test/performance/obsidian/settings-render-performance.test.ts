// @vitest-environment happy-dom
import { workSchedulerFromFrames } from "../../fixtures/obsidian/work-scheduler";

import type { App, Plugin } from "obsidian";
import { expect, it, vi } from "vitest";
import { InkbookSettingTab } from "../../../src/obsidian/settings/setting-tab";
import { SettingsModalContent } from "../../../src/obsidian/settings/settings-modal-content";
import { renderSettingsControlContent } from "../../../src/obsidian/settings/settings-control-content";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import { createTestSettingsStore } from "../../fixtures/obsidian/settings-store";
import { runInteractionFrames } from "../interaction-refresh-profile";

it("keeps unopened settings bounded and unrelated device changes without rebuilding controls", () => {
  installObsidianDomHelpers();
  const container = document.body.createDiv();
  const app = { workspace: { containerEl: container } } as unknown as App;
  const store = createTestSettingsStore();
  const content = new SettingsModalContent(container, {
    app,
    settingTab: new InkbookSettingTab(app, {} as Plugin, store, undefined, undefined, {
      workScheduler: () => workSchedulerFromFrames(window),
    }),
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
    runInteractionFrames((frame) => {
      store.updateDeviceSettings((settings) => ({
        ...settings,
        motion: frame % 2 === 0 ? "reduced" : "full",
      }));
    });
    expect(replace).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect([...container.querySelectorAll("*")]).toEqual(initialNodes);
  } finally {
    content.dispose();
    container.remove();
    vi.restoreAllMocks();
  }
});

it("projects one changed validation message and skips geometry work for repeated invalid and valid input", async () => {
  installObsidianDomHelpers();
  const group = document.body.createDiv({ cls: "inkbook-settings-tool-group" });
  const row = group.createDiv({ cls: "setting-item" });
  const following = group.createDiv({ cls: "setting-item" });
  following.createEl("button", { text: "Reset tool" });
  let saveResult = Promise.resolve();
  const release = renderSettingsControlContent(row, {
    controls: () => [
      { id: "opacity", kind: "number", label: "Opacity", min: 0, max: 1, step: 0.01, value: 1 },
    ],
    descriptions: {},
    idPrefix: "settings-work-opacity",
    onChange: () => saveResult,
    ownerDocument: document,
    readMotion: () => "full",
  });
  const field = row.querySelector<HTMLInputElement>('input[type="number"]')!;
  const error = row.querySelector<HTMLElement>(".inkbook-settings-control-error")!;
  const geometry = vi.spyOn(window.Element.prototype, "getBoundingClientRect");
  const submit = (value: string): void => {
    field.value = value;
    field.dispatchEvent(new Event("change"));
  };
  try {
    field.focus();
    submit("101");
    await Promise.resolve();
    expect(error.textContent).toBe("Enter a valid setting value.");
    expect(geometry.mock.contexts).toContain(row);
    expect(geometry.mock.contexts).toContain(following);
    geometry.mockClear();
    submit("102");
    await Promise.resolve();
    expect(geometry).not.toHaveBeenCalled();
    expect(error.hidden).toBe(false);

    submit("80");
    await Promise.resolve();
    // Every existing projection boundary needs at most its old and new geometry once.
    const reads = new Map<unknown, number>();
    for (const element of geometry.mock.contexts) reads.set(element, (reads.get(element) ?? 0) + 1);
    expect(reads.size).toBeGreaterThan(0);
    expect(Math.max(...reads.values())).toBeLessThanOrEqual(2);
    expect(error.hidden).toBe(true);
    geometry.mockClear();
    let rejectSave: ((reason: Error) => void) | undefined;
    saveResult = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    submit("70");
    await Promise.resolve();
    expect(geometry).not.toHaveBeenCalled();
    rejectSave?.(new Error("Save failed"));
    await Promise.resolve();
    expect(error.textContent).toBe("The setting could not be saved.");
    reads.clear();
    for (const element of geometry.mock.contexts) reads.set(element, (reads.get(element) ?? 0) + 1);
    expect(reads.size).toBeGreaterThan(0);
    expect(Math.max(...reads.values())).toBeLessThanOrEqual(2);
    expect(document.activeElement).toBe(field);
    expect(row.querySelector('input[type="number"]')).toBe(field);
  } finally {
    release();
    group.remove();
    geometry.mockRestore();
  }
});
