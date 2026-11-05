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

function mount(definition: SettingDefinitionRender, container = document.body): () => void {
  const group = new SettingGroup(container);
  const setting = new Setting(container).setName(definition.name);
  return definition.render(setting, group) ?? (() => undefined);
}

it("keeps native row identities stable and distinguishes identically named group resets", () => {
  const host = { getControlValue: () => false, setControlValue: () => undefined };
  const definitions = ["Input", "Interface"].map((heading) => ({
    type: "group" as const,
    cls: "shared-settings-group",
    heading,
    items: [{ name: "Reset group to defaults", render: vi.fn() }],
  }));
  const identities: string[] = [];
  for (const group of nativeSettingDefinitions(definitions, host)) {
    if (!("items" in group)) continue;
    for (const item of group.items ?? []) {
      if (!("render" in item) || item.render === undefined) continue;
      const row = document.body.createDiv();
      const release = mount(item, row);
      identities.push(row.dataset.inkbookSettingIdentity ?? "");
      release();
    }
  }
  expect(identities).toEqual(
    definitions.map((definition) =>
      JSON.stringify([
        JSON.stringify([definition.cls, definition.heading]),
        "Reset group to defaults",
      ]),
    ),
  );
});

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
  expect([field.value, field.min, field.max, field.step]).toEqual(["12", "1", "32", "1"]);
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
