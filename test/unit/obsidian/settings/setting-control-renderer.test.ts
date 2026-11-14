// @vitest-environment happy-dom

import {
  Setting,
  SettingGroup,
  type SettingDefinitionItem,
  type SettingDefinitionRender,
} from "obsidian";
import { beforeEach, expect, it, vi } from "vitest";

import {
  createBuiltInDeviceSettings,
  createBuiltInSettings,
} from "../../../../src/domain/settings";
import { nativeSettingDefinitions } from "../../../../src/obsidian/settings/setting-control-renderer";
import { InkbookSettingTab } from "../../../../src/obsidian/settings/setting-tab";
import { InkbookSettingsStore } from "../../../../src/obsidian/settings/storage";
import { SettingDefinitionRenderer } from "../../../../src/obsidian/settings/setting-definition-renderer";
import { refreshSettingsView } from "../../../../src/obsidian/settings/settings-view-refresh";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import type { PluginFontLibrary } from "../../../../src/obsidian/fonts/plugin-font-library";

beforeEach(() => {
  installObsidianDomHelpers();
  document.body.replaceChildren();
});

function findRender(
  definitions: readonly SettingDefinitionItem[],
  name: string,
): SettingDefinitionRender {
  for (const definition of definitions) {
    if ("render" in definition && definition.name === name && definition.render !== undefined) {
      return definition;
    }
    if ("items" in definition && definition.items !== undefined) {
      const found = definition.items.find((item) => "name" in item && item.name === name);
      if (found !== undefined && "render" in found && found.render !== undefined) return found;
    }
  }
  throw new Error(`Missing native setting: ${name}`);
}

function mount(definition: SettingDefinitionRender, container = document.body): () => void {
  const group = new SettingGroup(container);
  const setting = new Setting(container).setName(definition.name);
  return definition.render(setting, group) ?? (() => undefined);
}

it("opens font management from Text defaults", async () => {
  const store = new InkbookSettingsStore(
    { loadData: async () => createBuiltInSettings(), saveData: vi.fn() },
    { loadLocalStorage: () => createBuiltInDeviceSettings(), saveLocalStorage: vi.fn() },
  );
  const openFontManager = vi.fn();
  const tab = new InkbookSettingTab(
    {} as ConstructorParameters<typeof InkbookSettingTab>[0],
    {} as ConstructorParameters<typeof InkbookSettingTab>[1],
    store,
    undefined,
    undefined,
    {
      openFontManager,
      fontLibrary: {
        choices: () => [],
        library: { list: () => [] },
      } as unknown as PluginFontLibrary,
      workScheduler: () => new TestWorkScheduler(),
    },
  );
  const definitions = tab.getSettingDefinitions();
  expect(
    definitions.some(
      (item) => "heading" in item && item.heading === store.localization.t("fonts.group"),
    ),
  ).toBe(false);
  const dispose = mount(findRender(definitions, store.localization.t("settings.controls.text")));
  try {
    document.querySelector<HTMLButtonElement>(".inkbook-settings-tool-trigger")!.click();
    expect(document.querySelector('input[aria-label="Copy text fields as text"]')).toBeNull();
    const trigger = document.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    const confirmedFamily = tab.getControlValue("toolDefaults.text.fontFamily");
    trigger.click();
    const action = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === store.localization.t("fonts.manage"),
    )!;
    expect(action.closest('[role="listbox"]')).toBeNull();
    action.click();
    expect(openFontManager).toHaveBeenCalledExactlyOnceWith(trigger);
    expect(trigger.isConnected).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(tab.getControlValue("toolDefaults.text.fontFamily")).toBe(confirmedFamily);
  } finally {
    dispose();
  }
});

it("restores the correct native reset focus and action after groups rebuild in a new order", () => {
  const host = { getControlValue: () => false, setControlValue: () => undefined };
  const resets = { Appearance: vi.fn(), General: vi.fn() };
  const definitions = Object.entries(resets).map(([heading, reset]) => ({
    type: "group" as const,
    cls: "shared-settings-group",
    heading,
    items: [
      {
        name: "Reset group to defaults",
        render: (setting: Setting) => {
          setting.addButton((button) =>
            button.setButtonText("Reset group to defaults").onClick(reset),
          );
        },
      },
    ],
  }));
  const container = document.body.createDiv();
  const render = (order: typeof definitions): void => {
    container.replaceChildren();
    for (const group of nativeSettingDefinitions(order, host)) {
      if (!("items" in group) || !("heading" in group) || typeof group.heading !== "string")
        throw new Error("Expected a settings group.");
      const section = container.createEl("section");
      section.setAttribute("aria-label", group.heading);
      const item = group.items?.[0];
      if (item === undefined || !("render" in item) || item.render === undefined)
        throw new Error("Expected a native reset action.");
      mount(item, section.createDiv());
    }
  };
  const resetButton = (group: string): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>(`section[aria-label="${group}"] button`)!;
  render(definitions);
  const original = resetButton("Appearance");
  original.focus();
  refreshSettingsView(container, () => render([...definitions].reverse()));
  expect(original.isConnected).toBe(false);
  const replacement = resetButton("Appearance");
  expect(document.activeElement).toBe(replacement);
  replacement.click();
  expect(resets.Appearance).toHaveBeenCalledOnce();
  expect(resets.General).not.toHaveBeenCalled();
  resetButton("General").click();
  expect(resets.General).toHaveBeenCalledOnce();
  container.remove();
});

it.each([
  ["Selection highlights", "selectionHighlightsEnabled", false, "vault", "Performance"],
  ["Left-handed toolbar", "device.leftHandedToolbar", true, "device", "Appearance"],
  ["Copy text fields as text", "copyTextFieldsAsText", true, "vault", "General"],
] as const)(
  "recovers native %s writes with an associated error, focus and retry",
  async (name, key, next, scope, heading) => {
    let fail = true;
    let persistedVault = createBuiltInSettings();
    const save = vi.fn(() => {
      if (fail) throw new Error("Storage unavailable");
    });
    const store = new InkbookSettingsStore(
      {
        loadData: async () => persistedVault,
        saveData: async (settings) => {
          if (scope === "vault") save();
          persistedVault = structuredClone(settings);
        },
      },
      {
        loadLocalStorage: () => ({ ...createBuiltInDeviceSettings(), motion: "reduced" }),
        saveLocalStorage: () => {
          if (scope === "device") save();
        },
      },
    );
    await store.load();
    const tab = new InkbookSettingTab(
      {} as ConstructorParameters<typeof InkbookSettingTab>[0],
      {} as ConstructorParameters<typeof InkbookSettingTab>[1],
      store,
    );
    const definitions = tab.getSettingDefinitions();
    const group = definitions.find((item) => "heading" in item && item.heading === heading);
    if (group === undefined || !("items" in group)) throw new Error("Missing control group.");
    const dispose = mount(findRender(group.items ?? [], name));
    const input = document.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
    const confirmed = tab.getControlValue(key);
    input.focus();
    input.checked = next;
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(
        "could not be saved",
      ),
    );
    expect(input.checked).toBe(confirmed);
    expect(tab.getControlValue(key)).toBe(confirmed);
    expect(document.activeElement).toBe(input);
    const errorId = input.getAttribute("aria-describedby");
    expect(errorId).not.toBeNull();
    expect(document.getElementById(errorId!)?.textContent).toContain("could not be saved");
    fail = false;
    input.checked = next;
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(tab.getControlValue(key)).toBe(next));
    expect(persistedVault).toEqual(store.getVaultSettings());
    expect(save).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("");
    expect(document.activeElement).toBe(input);
    dispose();
    expect(input.hasAttribute("aria-describedby")).toBe(false);
  },
);

it("preserves searchable metadata, option labels, visibility and disabled native controls", () => {
  const visible = () => true;
  const definition = nativeSettingDefinitions(
    [
      {
        type: "group",
        heading: "General",
        items: [
          {
            name: "Placement",
            desc: "Choose a folder",
            aliases: ["Files"],
            searchable: false,
            visible,
            control: {
              type: "dropdown",
              key: "placement",
              disabled: () => true,
              options: { note: "Note folder" },
            },
          },
        ],
      },
    ],
    { getControlValue: () => "note", setControlValue: vi.fn() },
  );
  const rendered = findRender(definition, "Placement");
  expect(rendered).toMatchObject({
    name: "Placement",
    desc: "Choose a folder",
    aliases: ["Files", "Note folder"],
    searchable: false,
    visible,
  });
  expect(rendered.control).toBeUndefined();
  const dispose = mount(rendered);
  expect(document.querySelector<HTMLSelectElement>("select")?.disabled).toBe(true);
  dispose();
});

it("validates native hold fields, preserves disabled values and resets only their group", async () => {
  const save = vi.fn(async () => undefined);
  const store = new InkbookSettingsStore(
    { loadData: async () => createBuiltInSettings(), saveData: save },
    { loadLocalStorage: () => createBuiltInDeviceSettings(), saveLocalStorage: vi.fn() },
  );
  const tab = new InkbookSettingTab(
    {} as ConstructorParameters<typeof InkbookSettingTab>[0],
    {} as ConstructorParameters<typeof InkbookSettingTab>[1],
    store,
  );
  await tab.setControlValue("startupTool", "arrow");
  await tab.setControlValue("holdToShape.holdDurationMs", 950);
  await tab.setControlValue("holdToShape.enabled", false);
  let release = mount(findRender(tab.getSettingDefinitions(), "Hold delay"));
  let field = document.querySelector<HTMLInputElement>(
    'input[type="number"][aria-label="Hold delay"]',
  )!;
  let slider = document.querySelector<HTMLInputElement>(
    'input[type="range"][aria-label="Hold delay"]',
  )!;
  expect(field.disabled).toBe(true);
  expect(slider.disabled).toBe(true);
  expect(field.value).toBe("950");
  release();
  document.body.replaceChildren();
  await tab.setControlValue("holdToShape.enabled", true);
  release = mount(findRender(tab.getSettingDefinitions(), "Hold delay"));
  field = document.querySelector<HTMLInputElement>(
    'input[type="number"][aria-label="Hold delay"]',
  )!;
  slider = document.querySelector<HTMLInputElement>(
    'input[type="range"][aria-label="Hold delay"]',
  )!;
  expect(slider.disabled).toBe(false);
  expect([field.min, field.max, field.step]).toEqual(["200", "2000", "50"]);
  field.focus();
  field.value = "199";
  field.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(field.value).toBe("950"));
  expect(tab.getControlValue("holdToShape.holdDurationMs")).toBe(950);
  expect(document.activeElement).toBe(field);
  const associatedText = (field.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
  expect(associatedText).toContain("Enter a valid setting value.");
  slider.value = "1200";
  slider.dispatchEvent(new Event("input"));
  expect(field.value).toBe("1200");
  expect(tab.getControlValue("holdToShape.holdDurationMs")).toBe(950);
  slider.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(tab.getControlValue("holdToShape.holdDurationMs")).toBe(1200));
  release();
  document.body.replaceChildren();
  release = mount(findRender(tab.getSettingDefinitions(), "Movement tolerance"));
  field = document.querySelector<HTMLInputElement>(
    'input[type="number"][aria-label="Movement tolerance"]',
  )!;
  slider = document.querySelector<HTMLInputElement>(
    'input[type="range"][aria-label="Movement tolerance"]',
  )!;
  expect([field.value, field.min, field.max, field.step]).toEqual(["20", "1", "32", "1"]);
  field.focus();
  field.value = "32";
  field.dispatchEvent(new Event("input"));
  expect(slider.value).toBe("32");
  field.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(tab.getControlValue("holdToShape.jitterTolerancePx")).toBe(32));
  release();
  const group = tab
    .getControlDefinitions()
    .find((item) => "heading" in item && item.heading === "Hold to shape");
  const renderer = new SettingDefinitionRenderer(tab, vi.fn());
  renderer.render(document.body, group === undefined ? [] : [group]);
  document.querySelector<HTMLElement>('[role="button"]')!.click();
  await vi.waitFor(() =>
    expect(store.getVaultSettings().holdToShape).toEqual(createBuiltInSettings().holdToShape),
  );
  expect(store.getVaultSettings().startupTool).toBe("arrow");
  renderer.dispose();
});

it.each(["host", "pagehide", "abort"] as const)(
  "disposes native write feedback on %s teardown",
  async (reason) => {
    const lifetime = new AbortController();
    let reject: ((error: Error) => void) | undefined;
    const setControlValue = vi.fn(
      () =>
        new Promise<void>((_resolve, rejectWrite) => {
          reject = rejectWrite;
        }),
    );
    const unsubscribe = vi.fn();
    const definitions = nativeSettingDefinitions(
      [{ name: "Preference", control: { type: "toggle", key: "preference" } }],
      {
        getControlValue: () => false,
        setControlValue,
        settingsFeedback: { readMotion: () => "reduced", observeMotion: () => unsubscribe },
      },
      lifetime.signal,
    );
    const dispose = mount(findRender(definitions, "Preference"));
    const input = document.querySelector<HTMLInputElement>("input")!;
    input.click();
    reject?.(new Error("Storage unavailable"));
    await vi.waitFor(() => expect(document.querySelector('[aria-live="polite"]')).not.toBeNull());
    if (reason === "host") dispose();
    else if (reason === "pagehide") window.dispatchEvent(new Event("pagehide"));
    else lifetime.abort();
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(document.querySelector('[aria-live="polite"]')).toBeNull();
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    input.click();
    expect(setControlValue).toHaveBeenCalledOnce();
  },
);
