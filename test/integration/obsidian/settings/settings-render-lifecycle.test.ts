// @vitest-environment happy-dom
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

import { Setting, SettingGroup } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toolSectionDefinition } from "../../../../src/obsidian/settings/definitions/tool-section";
import { ShortcutSettingsView } from "../../../../src/obsidian/settings/shortcuts/shortcut-view";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";
import { keymapCaptureFixture } from "../../../fixtures/obsidian/keymap-capture";
import { SettingsViewState } from "../../../../src/obsidian/settings/settings-view-state";

const captureKeymap = keymapCaptureFixture();

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("builds tool controls from current defaults on first expansion and retains them", async () => {
  const { container, trigger, readDefaults, store, cleanup } = createTool();
  expect(container.querySelector("input")).toBeNull();
  expect(readDefaults).not.toHaveBeenCalled();
  await store.updateVaultSettings((settings) => {
    settings.toolDefaults.eraser.radius = 24;
    return settings;
  });
  store.updateDeviceSettings((settings) => ({ ...settings, motion: "full" }));
  trigger.click();
  expect(container.querySelector<HTMLInputElement>("input[type=number]")?.value).toBe("24");
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

it("retains an open tool after reset and rebuild without sharing another surface's state", async () => {
  const state = new SettingsViewState();
  const first = createTool(state);
  await first.store.updateVaultSettings((settings) => {
    settings.toolDefaults.eraser.radius = 32;
    return settings;
  });
  first.trigger.click();
  first.cleanup();
  first.container.remove();
  await first.store.resetAll();
  const rebuilt = createTool(state, first.store);
  const independent = createTool(new SettingsViewState(), first.store);
  expect(rebuilt.trigger.getAttribute("aria-expanded")).toBe("true");
  expect(rebuilt.panel.hidden).toBe(false);
  expect(rebuilt.panel.inert).toBe(false);
  expect(rebuilt.container.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe(
    "20",
  );
  expect(rebuilt.readDefaults).toHaveBeenCalledOnce();
  expect(independent.trigger.getAttribute("aria-expanded")).toBe("false");
  expect(independent.container.querySelector("input")).toBeNull();
  rebuilt.trigger.click();
  expect(state.expandedSections.has("tool:eraser")).toBe(false);
  rebuilt.cleanup();
  independent.cleanup();
});

it("retains shortcut disclosures across reset and remount independently of other surfaces", async () => {
  const state = new SettingsViewState();
  const first = createShortcuts(state);
  first.container.querySelector<HTMLButtonElement>(".inkbook-shortcut-section-trigger")!.click();
  first.store.updateDeviceSettings((settings) => ({
    ...settings,
    keyboardShortcuts: { ...settings.keyboardShortcuts, copy: null },
  }));
  expect(first.container.querySelector("[aria-expanded=true]")).not.toBeNull();
  first.view.dispose();
  first.container.remove();
  await first.store.resetAll();
  const rebuilt = createShortcuts(state, first.store);
  const independent = createShortcuts(new SettingsViewState(), first.store);
  const trigger = rebuilt.container.querySelector<HTMLButtonElement>(
    ".inkbook-shortcut-section-trigger",
  )!;
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const panel = rebuilt.container.querySelector<HTMLElement>(
    `[id="${trigger.getAttribute("aria-controls")}"]`,
  )!;
  expect(panel.hidden).toBe(false);
  expect(panel.inert).toBe(false);
  expect(independent.container.querySelector("[aria-expanded=true]")).toBeNull();
  trigger.click();
  expect(state.expandedSections.has("shortcut:canvas")).toBe(false);
  rebuilt.view.dispose();
  independent.view.dispose();
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

function createShortcuts(viewState?: SettingsViewState, store = createTestSettingsStore()) {
  const container = document.body.createDiv();
  const keymap = captureKeymap(window);
  return {
    container,
    store,
    view: new ShortcutSettingsView(
      container,
      store,
      keymap,
      undefined,
      () => workSchedulerFromFrames(window),
      viewState,
    ),
  };
}

function createTool(viewState?: SettingsViewState, store = createTestSettingsStore()) {
  const container = document.body.createDiv();
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
      ...(viewState === undefined ? {} : { viewState }),
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
