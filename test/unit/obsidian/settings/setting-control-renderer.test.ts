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
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

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

function mount(definition: SettingDefinitionRender): () => void {
  const group = new SettingGroup(document.body);
  const setting = new Setting(document.body).setName(definition.name);
  return definition.render(setting, group) ?? (() => undefined);
}

it.each([
  ["Selection highlights", "selectionHighlightsEnabled", false, "vault"],
  ["Left-handed toolbar", "device.leftHandedToolbar", true, "device"],
] as const)(
  "recovers native %s writes with an associated error, focus and retry",
  async (name, key, next, scope) => {
    let fail = true;
    const save = vi.fn(() => {
      if (fail) throw new Error("Storage unavailable");
    });
    const store = new InkbookSettingsStore(
      {
        loadData: async () => createBuiltInSettings(),
        saveData: async () => {
          if (scope === "vault") save();
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
    const dispose = mount(findRender(tab.getSettingDefinitions(), name));
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
