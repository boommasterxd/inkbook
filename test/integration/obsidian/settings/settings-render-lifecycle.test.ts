// @vitest-environment happy-dom
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

import { Setting, SettingGroup } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toolSectionDefinition } from "../../../../src/obsidian/settings/tool-section";
import { ShortcutSettingsView } from "../../../../src/obsidian/settings/shortcut-view";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("builds tool controls from current defaults before measuring the first expansion and retains them", async () => {
  const { container, trigger, panel, readDefaults, store, cleanup } = createTool();
  expect(container.querySelector("input")).toBeNull();
  expect(readDefaults).not.toHaveBeenCalled();
  await store.updateVaultSettings((settings) => {
    settings.toolDefaults.eraser.radius = 24;
    return settings;
  });
  store.updateDeviceSettings((settings) => ({ ...settings, motion: "full" }));
  const measure = vi.spyOn(panel, "getBoundingClientRect").mockImplementation(() => {
    expect(container.querySelector<HTMLInputElement>("input[type=number]")?.value).toBe("24");
    return new DOMRect(0, 0, 300, 120);
  });
  trigger.click();
  expect(measure).toHaveBeenCalled();
  const input = container.querySelector("input");
  trigger.click();
  trigger.click();
  expect(container.querySelector("input")).toBe(input);
  expect(readDefaults).toHaveBeenCalledOnce();
  cleanup();
});

it("does not initialize an unopened tool after disposal", () => {
  const { container, trigger, readDefaults, cleanup } = createTool();
  cleanup();
  trigger.click();
  expect(container.querySelector("input")).toBeNull();
  expect(readDefaults).not.toHaveBeenCalled();
});

it("keeps shortcut DOM, focus and active recording on unrelated device changes", () => {
  const { container, store, view } = createShortcuts();
  container.querySelector<HTMLButtonElement>(".inkbook-shortcut-section-trigger")?.click();
  container.querySelector<HTMLButtonElement>(".inkbook-shortcut-recorder")?.click();
  const recorder = container.querySelector<HTMLButtonElement>(".inkbook-shortcut-recorder");
  expect(recorder?.dataset.recording).toBe("true");
  expect(document.activeElement).toBe(recorder);
  const replace = vi.spyOn(container, "replaceChildren");
  store.updateDeviceSettings((settings) => ({ ...settings, motion: "reduced" }));
  store.updateDeviceSettings((settings) => ({ ...settings, leftHandedToolbar: true }));
  expect(replace).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(recorder);
  recorder?.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  expect(replace).toHaveBeenCalledOnce();
  expect(store.getDeviceSettings().keyboardShortcuts["select-all"]?.key).toBe("k");
  expect(container.querySelector("[data-recording=true]")).toBeNull();
  view.dispose();
});

it("refreshes changed bindings, ignores equivalent clones and releases its subscription", () => {
  const { container, store, view } = createShortcuts();
  const replace = vi.spyOn(container, "replaceChildren");
  store.updateDeviceSettings((settings) => ({
    ...settings,
    keyboardShortcuts: { ...settings.keyboardShortcuts, copy: { key: "k", modifiers: ["mod"] } },
  }));
  expect(replace).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-shortcut-action="copy"]')?.textContent).toContain("K");
  store.updateDeviceSettings((settings) => ({
    ...settings,
    keyboardShortcuts: structuredClone(settings.keyboardShortcuts),
    fingerDrawingEnabled: !settings.fingerDrawingEnabled,
  }));
  expect(replace).toHaveBeenCalledOnce();
  view.dispose();
  replace.mockClear();
  store.updateDeviceSettings((settings) => ({
    ...settings,
    keyboardShortcuts: { ...settings.keyboardShortcuts, copy: null },
  }));
  expect(replace).not.toHaveBeenCalled();
});

function createShortcuts() {
  const container = document.body.createDiv();
  const store = createTestSettingsStore();
  return {
    container,
    store,
    view: new ShortcutSettingsView(container, store, undefined, () =>
      workSchedulerFromFrames(window),
    ),
  };
}

function createTool() {
  const container = document.body.createDiv();
  const store = createTestSettingsStore();
  const readDefaults = vi.fn(() => store.getVaultSettings().toolDefaults);
  const definition = toolSectionDefinition(
    {
      name: "Eraser",
      description: "Eraser defaults",
      tool: "eraser",
      controlDescriptions: {},
      controlKeys: { "eraser-radius": "toolDefaults.eraser.radius" },
    },
    {
      getDefaults: readDefaults,
      getMotion: () => store.getDeviceSettings().motion,
      workScheduler: () => workSchedulerFromFrames(window),
      set: () => Promise.resolve(),
    },
  );
  const cleanup = definition.render(new Setting(container), new SettingGroup(container));
  const trigger = container.querySelector<HTMLButtonElement>(".inkbook-settings-tool-trigger");
  const panel = container.querySelector<HTMLElement>(".inkbook-settings-tool-panel");
  if (trigger === null || panel === null) throw new Error("Missing tool disclosure");
  return { container, store, readDefaults, trigger, panel, cleanup: () => cleanup?.() };
}
