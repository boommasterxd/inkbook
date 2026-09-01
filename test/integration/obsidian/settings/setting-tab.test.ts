// @vitest-environment happy-dom

import { beforeAll, describe, expect, it, vi } from "vitest";

import { type SettingDefinitionItem, type SettingDefinitionRender } from "obsidian";

import {
  createBuiltInDeviceSettings,
  createBuiltInSettings,
} from "../../../../src/domain/settings";
import type { SettingsControlKey } from "../../../../src/obsidian/settings/control-values";
import { InkbookSettingsStore } from "../../../../src/obsidian/settings/storage";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import {
  createTab,
  DeviceAdapter,
  groups,
  renderDefinition,
  renders,
  VaultAdapter,
} from "./setting-tab-fixture";

beforeAll(() => {
  installObsidianDomHelpers();
});

function declarativeLabels(
  definitions: readonly SettingDefinitionItem<SettingsControlKey>[],
): string[] {
  const labels: string[] = [];
  for (const definition of definitions) {
    if ("heading" in definition && definition.heading !== undefined) {
      labels.push(definition.heading);
    }
    if ("name" in definition) labels.push(definition.name);
    if (
      "control" in definition &&
      definition.control !== undefined &&
      definition.control.type === "dropdown"
    ) {
      labels.push(...Object.values(definition.control.options));
    }
    if ("items" in definition && definition.items !== undefined) {
      labels.push(...declarativeLabels(definition.items));
    }
  }
  return labels;
}

function renderedLabels(definition: SettingDefinitionRender): string[] {
  const rendered = renderDefinition(definition);
  const labels = [
    ...rendered.container.querySelectorAll(
      ".inkbook-settings-tool-title, .inkbook-menu-control-header, .inkbook-menu-toggle-heading",
    ),
  ].flatMap((element) => (element.textContent === null ? [] : [element.textContent]));
  rendered.cleanup();
  return labels;
}

function resetGroup(tab: ReturnType<typeof createTab>, heading: string | undefined): void {
  const group = groups(tab).find((candidate) => candidate.heading === heading);
  const action = group?.items?.find(
    (item): item is SettingDefinitionRender =>
      item.name === "Reset group to defaults" && "render" in item,
  );
  if (action === undefined) throw new Error(`Missing reset action for ${heading ?? "General"}.`);
  const rendered = renderDefinition(action);
  rendered.container.click();
  rendered.cleanup();
}

function isRenderDefinition(
  definition: SettingDefinitionItem<SettingsControlKey>,
): definition is SettingDefinitionRender {
  return "render" in definition && typeof definition.render === "function";
}

describe("InkbookSettingTab definitions", () => {
  it("returns the required groups in order without storage access", () => {
    const vault = new VaultAdapter();
    const device = new DeviceAdapter();
    const tab = createTab(new InkbookSettingsStore(vault, device));

    const definitions = tab.getSettingDefinitions();

    expect(groups(tab).map((group) => group.heading)).toEqual([
      undefined,
      "Page defaults",
      "Drawing tools",
      "Shapes and structures",
      "Snapping",
      "Input",
      "Interface",
      "Shortcuts",
    ]);
    expect(definitions[definitions.length - 1]).toMatchObject({
      name: "Reset all Inkbook settings",
    });
    expect(vault.loads).toBe(0);
    expect(vault.saves).toBe(0);
    expect(device.loads).toBe(0);
    expect(device.saves).toBe(0);
  });

  it("renders reset tones through declarative host render callbacks", () => {
    const tab = createTab(new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter()));
    const generalReset = groups(tab)[0]?.items?.find(
      (item): item is SettingDefinitionRender =>
        item.name === "Reset group to defaults" && "render" in item,
    );
    const definitions = tab.getSettingDefinitions();
    const resetAll = definitions[definitions.length - 1];
    if (generalReset === undefined || resetAll === undefined || !isRenderDefinition(resetAll)) {
      throw new Error("Missing rendered reset definitions.");
    }

    const groupRow = renderDefinition(generalReset);
    const globalRow = renderDefinition(resetAll);

    expect(groupRow.container.dataset.inkbookSettingActionTone).toBe("caution");
    expect(globalRow.container.dataset.inkbookSettingActionTone).toBe("danger");
    expect(groupRow.container.classList).toContain("mod-action");
    expect(globalRow.container.classList).toContain("mod-action");

    groupRow.cleanup();
    globalRow.cleanup();
  });

  it("exposes structural pages and conditional folder rows", async () => {
    const store = new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter());
    const tab = createTab(store);
    const general = groups(tab)[0];
    expect(general).toBeDefined();
    expect(general?.items?.map((item) => item.name)).toEqual([
      "Startup tool",
      "Display refresh rate",
      "File placement",
      "Custom vault folder",
      "Create custom folder",
      "Reset group to defaults",
    ]);
    const customFolder = general?.items?.find((item) => item.name === "Custom vault folder");
    expect(typeof customFolder?.visible === "function" && customFolder.visible()).toBe(false);
    await tab.setControlValue("filePlacement.mode", "custom-vault-folder");
    expect(typeof customFolder?.visible === "function" && customFolder.visible()).toBe(true);
  });

  it("places Select first in Drawing tools with both shared choice controls", () => {
    const tab = createTab(new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter()));
    const drawing = groups(tab).find((group) => group.heading === "Drawing tools");
    const tools = drawing === undefined ? [] : renders(drawing);

    expect(tools[0]?.name).toBe("Select");
    expect(tools[0] === undefined ? [] : renderedLabels(tools[0])).toEqual([
      "Select",
      "Selection area",
      "Include elements",
    ]);
  });
});

describe("InkbookSettingTab snapping and refresh definitions", () => {
  it("exposes global and per-kind snapping controls", async () => {
    const store = new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter());
    const tab = createTab(store);
    const snapping = groups(tab).find((group) => group.heading === "Snapping");
    const items = snapping?.items ?? [];

    expect(items.map((item) => item.name)).toEqual([
      "Enable snapping",
      "Angle snapping",
      "Bend snapping",
      "Connection snapping",
      "Structure snapping",
      "Reset group to defaults",
    ]);
    const angles = items.find((item) => item.name === "Angle snapping");
    expect(angles !== undefined && "render" in angles).toBe(true);
    await tab.setControlValue("snapping.enabled", false);
    expect(tab.getControlValue("snapping.enabled")).toBe(false);
    expect(store.getVaultSettings().snapping.angles).toBe(true);
  });

  it("shows the live automatic refresh-rate result in the selected option", () => {
    const store = new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter());
    const detectingTab = createTab(store, () => ({ kind: "detecting", refreshRate: 120 }));
    const detectingRate = groups(detectingTab)[0]?.items?.find(
      (item) => item.name === "Display refresh rate",
    );
    const tab = createTab(store, () => ({ kind: "detected", refreshRate: 144 }));
    const refreshRate = groups(tab)[0]?.items?.find((item) => item.name === "Display refresh rate");
    if (refreshRate === undefined || !("control" in refreshRate)) {
      throw new Error("Missing display refresh-rate control.");
    }
    if (detectingRate === undefined || !("control" in detectingRate)) {
      throw new Error("Missing detecting refresh-rate control.");
    }

    expect(
      detectingRate.control?.type === "dropdown"
        ? detectingRate.control.options["auto"]
        : undefined,
    ).toBe("Auto (detecting…)");
    expect(refreshRate.control?.type).toBe("dropdown");
    if (refreshRate.control?.type !== "dropdown") throw new Error("Expected dropdown control.");
    expect(refreshRate.control.options["auto"]).toBe("Auto (detected: 144 Hz)");
    expect(refreshRate.desc).toBe(
      "Detected 144 Hz for this Obsidian window. Other windows are measured independently.",
    );
  });
});

describe("InkbookSettingTab visible labels", () => {
  it("uses sentence case for every multi-word designation", () => {
    const tab = createTab(new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter()));
    const definitions = tab.getSettingDefinitions();
    const shapes = groups(tab).find((group) => group.heading === "Shapes and structures");
    if (shapes === undefined) throw new Error("Missing Shapes and structures group");
    const shapeLabels = renders(shapes).flatMap(renderedLabels);
    const multiWordLabels = [...new Set([...declarativeLabels(definitions), ...shapeLabels])]
      .filter((label) => label.includes(" "))
      .sort();
    const sentenceCase = /^[A-Z][A-Za-z0-9-]*(?: (?:[a-z0-9][a-z0-9-]*|Inkbook|Obsidian|2D|3D))*$/u;

    expect(multiWordLabels).toEqual(
      expect.arrayContaining(["Straight highlighter", "Coordinate system"]),
    );
    expect(
      multiWordLabels.filter(
        (label) =>
          !sentenceCase.test(label) &&
          !/^\d+ Hz$/.test(label) &&
          !/^Auto \((?:detected: \d+ Hz|detecting…)\)$/.test(label),
      ),
    ).toEqual([]);
  });
});

describe("InkbookSettingTab reset integration", () => {
  it("resets every logical group without changing the others", async () => {
    const store = new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter());
    const tab = createTab(store);
    const defaults = createBuiltInSettings();
    const deviceDefaults = createBuiltInDeviceSettings();

    await tab.setControlValue("startupTool", "arrow");
    await tab.setControlValue("pageDefaults.activeBufferLines", 6);
    await tab.setControlValue("toolDefaults.pen.width", 14);
    await tab.setControlValue("toolDefaults.select.area", "lasso");
    await tab.setControlValue("toolDefaults.shapes.rectangle.outlineWidth", 8);
    await tab.setControlValue("snapping.angles", false);
    await tab.setControlValue("device.fingerDrawingEnabled", !deviceDefaults.fingerDrawingEnabled);
    await tab.setControlValue("device.leftHandedToolbar", !deviceDefaults.leftHandedToolbar);

    resetGroup(tab, undefined);
    await vi.waitFor(() => expect(tab.getControlValue("startupTool")).toBe(defaults.startupTool));
    expect(store.getVaultSettings()).toMatchObject({
      filePlacement: defaults.filePlacement,
      refreshRatePreference: defaults.refreshRatePreference,
      startupTool: defaults.startupTool,
    });
    expect(tab.getControlValue("pageDefaults.activeBufferLines")).toBe(6);
    resetGroup(tab, "Page defaults");
    await vi.waitFor(() =>
      expect(tab.getControlValue("pageDefaults.activeBufferLines")).toBe(
        defaults.pageDefaults.activeBufferLines,
      ),
    );
    expect(store.getVaultSettings().pageDefaults).toEqual(defaults.pageDefaults);
    resetGroup(tab, "Drawing tools");
    await vi.waitFor(() =>
      expect(tab.getControlValue("toolDefaults.pen.width")).toBe(defaults.toolDefaults.pen.width),
    );
    expect(store.getVaultSettings().toolDefaults).toMatchObject({
      eraser: defaults.toolDefaults.eraser,
      highlighter: defaults.toolDefaults.highlighter,
      pen: defaults.toolDefaults.pen,
      select: defaults.toolDefaults.select,
      straightHighlighter: defaults.toolDefaults.straightHighlighter,
    });
    resetGroup(tab, "Snapping");
    await vi.waitFor(() =>
      expect(tab.getControlValue("snapping.angles")).toBe(defaults.snapping.angles),
    );
    expect(store.getVaultSettings().snapping).toEqual(defaults.snapping);
    resetGroup(tab, "Shapes and structures");
    await vi.waitFor(() =>
      expect(tab.getControlValue("toolDefaults.shapes.rectangle.outlineWidth")).toBe(
        defaults.toolDefaults.shapes.rectangle.outlineWidth,
      ),
    );
    expect(store.getVaultSettings().toolDefaults).toMatchObject({
      arrow: defaults.toolDefaults.arrow,
      coordinateSystem: defaults.toolDefaults.coordinateSystem,
      shapes: defaults.toolDefaults.shapes,
      table: defaults.toolDefaults.table,
    });
    resetGroup(tab, "Input");
    expect(tab.getControlValue("device.fingerDrawingEnabled")).toBe(
      deviceDefaults.fingerDrawingEnabled,
    );
    expect(store.getDeviceSettings()).toMatchObject({
      fingerDrawingEnabled: deviceDefaults.fingerDrawingEnabled,
      penTapInsertion: deviceDefaults.penTapInsertion,
    });
    resetGroup(tab, "Interface");
    expect(tab.getControlValue("device.leftHandedToolbar")).toBe(deviceDefaults.leftHandedToolbar);
    expect(store.getDeviceSettings()).toMatchObject({
      leftHandedToolbar: deviceDefaults.leftHandedToolbar,
      motion: deviceDefaults.motion,
    });
  });
});

describe("InkbookSettingTab full reset integration", () => {
  it("requires confirmation before resetting both scopes", async () => {
    const vault = new VaultAdapter();
    const device = new DeviceAdapter();
    const store = new InkbookSettingsStore(vault, device);
    await store.load();
    await store.updateVaultSettings((settings) => ({ ...settings, startupTool: "arrow" }));
    device.value.motion = "full";
    const tab = createTab(store);
    const definitions = tab.getSettingDefinitions();
    const action = definitions[definitions.length - 1] as SettingDefinitionRender;
    const confirmMock = vi.fn(() => false);
    Object.defineProperty(window, "confirm", { configurable: true, value: confirmMock });
    const rendered = renderDefinition(action);

    rendered.container.click();
    await Promise.resolve();
    expect(store.getVaultSettings().startupTool).toBe("arrow");

    confirmMock.mockReturnValue(true);
    rendered.container.click();
    await vi.waitFor(() => expect(store.getVaultSettings()).toEqual(createBuiltInSettings()));
    expect(device.value).toEqual(createBuiltInDeviceSettings());
    rendered.cleanup();
    Reflect.deleteProperty(window, "confirm");
  });
});
