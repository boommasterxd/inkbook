// @vitest-environment happy-dom

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SettingDefinitionRender } from "obsidian";

import {
  createBuiltInDeviceSettings,
  createBuiltInSettings,
} from "../../../../src/domain/settings";
import { InkbookSettingsStore } from "../../../../src/obsidian/settings/storage";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import {
  confirmAction,
  createTab,
  DeviceAdapter,
  groups,
  renderDefinition,
  VaultAdapter,
} from "./setting-tab-fixture";

beforeAll(installObsidianDomHelpers);

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

function createResetFixture() {
  const store = new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter());
  return {
    store,
    tab: createTab(store),
    defaults: createBuiltInSettings(),
    deviceDefaults: createBuiltInDeviceSettings(),
  };
}

describe("InkbookSettingTab General, Appearance and Performance reset integration", () => {
  it("isolates General, Appearance and Performance resets across both storage scopes", async () => {
    const { store, tab, defaults, deviceDefaults } = createResetFixture();
    await tab.setControlValue("startupTool", "arrow");
    await tab.setControlValue("selectionHighlightsEnabled", false);
    await tab.setControlValue("refreshRatePreference", 60);
    await tab.setControlValue("filePlacement.mode", "note-folder");
    expect(tab.getControlValue("selectionHighlightsEnabled")).toBe(false);
    await tab.setControlValue("pageDefaults.activeBufferLines", 6);
    await tab.setControlValue("device.leftHandedToolbar", !deviceDefaults.leftHandedToolbar);
    await tab.setControlValue("device.language", "en");
    await tab.setControlValue("device.motion", "reduced");
    await tab.setControlValue("copyTextFieldsAsText", true);
    await tab.setControlValue("device.fingerDrawingEnabled", !deviceDefaults.fingerDrawingEnabled);
    await tab.setControlValue("toolDefaults.pen.width", 14);
    await tab.setControlValue("device.scrollPreloadMarginPx", 800);
    const retainedDevice = structuredClone(store.getDeviceSettings());

    resetGroup(tab, "General");
    await vi.waitFor(() => expect(tab.getControlValue("startupTool")).toBe(defaults.startupTool));
    expect(store.getVaultSettings()).toMatchObject({
      filePlacement: defaults.filePlacement,
      selectionHighlightsEnabled: false,
      refreshRatePreference: 60,
      startupTool: defaults.startupTool,
      copyTextFieldsAsText: defaults.copyTextFieldsAsText,
    });
    expect(store.getDeviceSettings()).toEqual(retainedDevice);
    expect(tab.getControlValue("toolDefaults.pen.width")).toBe(14);
    expect(tab.getControlValue("pageDefaults.activeBufferLines")).toBe(6);
    expect(tab.getControlValue("device.scrollPreloadMarginPx")).toBe(800);
    await tab.setControlValue("startupTool", "arrow");
    await tab.setControlValue("filePlacement.mode", "note-folder");
    await tab.setControlValue("copyTextFieldsAsText", true);
    const retainedVault = structuredClone(store.getVaultSettings());
    resetGroup(tab, "Appearance");
    await vi.waitFor(() =>
      expect(store.getDeviceSettings()).toEqual({
        ...retainedDevice,
        language: deviceDefaults.language,
        leftHandedToolbar: deviceDefaults.leftHandedToolbar,
        motion: deviceDefaults.motion,
      }),
    );
    expect(store.getVaultSettings()).toEqual(retainedVault);
    resetGroup(tab, "Performance");
    await vi.waitFor(() => expect(tab.getControlValue("device.scrollPreloadMarginPx")).toBe(300));
    expect(store.getVaultSettings()).toMatchObject({
      selectionHighlightsEnabled: defaults.selectionHighlightsEnabled,
      refreshRatePreference: defaults.refreshRatePreference,
      startupTool: "arrow",
      filePlacement: { mode: "note-folder" },
    });
    expect(tab.getControlValue("pageDefaults.activeBufferLines")).toBe(6);
    expect(tab.getControlValue("device.leftHandedToolbar")).toBe(deviceDefaults.leftHandedToolbar);
  });
});

describe("InkbookSettingTab remaining group reset integration", () => {
  it("resets every remaining logical group without changing the others", async () => {
    const { store, tab, defaults, deviceDefaults } = createResetFixture();
    await tab.setControlValue("pageDefaults.activeBufferLines", 6);
    await tab.setControlValue("toolDefaults.pen.width", 14);
    await tab.setControlValue("copyTextFieldsAsText", true);
    await tab.setControlValue("toolDefaults.pen.holdToShapeEnabled", false);
    await tab.setControlValue("toolDefaults.line.snappingEnabled", false);
    await tab.setControlValue("toolDefaults.arrow.snappingEnabled", false);
    await tab.setControlValue("toolDefaults.select.area", "rectangle");
    await tab.setControlValue("toolDefaults.shapes.rectangle.outlineWidth", 8);
    await tab.setControlValue("toolDefaults.shapes.rectangle.fillOpacity", 0.1);
    await tab.setControlValue("snapping.angles", false);
    await tab.setControlValue("device.fingerDrawingEnabled", !deviceDefaults.fingerDrawingEnabled);
    await tab.setControlValue("device.leftHandedToolbar", !deviceDefaults.leftHandedToolbar);
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
    expect(tab.getControlValue("toolDefaults.select.area")).toBe("lasso");
    expect(tab.getControlValue("copyTextFieldsAsText")).toBe(true);
    expect(tab.getControlValue("toolDefaults.line.snappingEnabled")).toBe(false);
    expect(tab.getControlValue("toolDefaults.arrow.snappingEnabled")).toBe(false);
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
      line: defaults.toolDefaults.line,
      coordinateSystem: defaults.toolDefaults.coordinateSystem,
      shapes: defaults.toolDefaults.shapes,
      table: defaults.toolDefaults.table,
    });
    expect(tab.getControlValue("toolDefaults.shapes.rectangle.fillOpacity")).toBe(0.5);
    resetGroup(tab, "Input");
    expect(tab.getControlValue("device.fingerDrawingEnabled")).toBe(
      deviceDefaults.fingerDrawingEnabled,
    );
    expect(store.getDeviceSettings()).toMatchObject({
      fingerDrawingEnabled: deviceDefaults.fingerDrawingEnabled,
      penTapInsertion: deviceDefaults.penTapInsertion,
    });
    expect(tab.getControlValue("device.leftHandedToolbar")).toBe(!deviceDefaults.leftHandedToolbar);
  });
});

describe("InkbookSettingTab full reset integration", () => {
  it("does not reset after the settings surface closes during confirmation", async () => {
    const store = new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter());
    await store.load();
    await store.updateVaultSettings((settings) => ({ ...settings, startupTool: "arrow" }));
    const definitions = createTab(store).getControlDefinitions();
    const rendered = renderDefinition(
      definitions[definitions.length - 1] as SettingDefinitionRender,
    );
    document.body.append(rendered.container);
    let finish: ((confirmed: boolean) => void) | undefined;
    confirmAction.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    rendered.container.click();
    rendered.container.remove();
    finish?.(true);
    await Promise.resolve();
    expect(store.getVaultSettings().startupTool).toBe("arrow");
    rendered.cleanup();
  });

  it("requires confirmation before resetting both scopes", async () => {
    const vault = new VaultAdapter();
    const device = new DeviceAdapter();
    const store = new InkbookSettingsStore(vault, device);
    await store.load();
    await store.updateVaultSettings((settings) => ({ ...settings, startupTool: "arrow" }));
    device.value.motion = "full";
    const tab = createTab(store);
    const definitions = tab.getControlDefinitions();
    const action = definitions[definitions.length - 1] as SettingDefinitionRender;
    const confirmMock = confirmAction.mockResolvedValue(false);
    const rendered = renderDefinition(action);
    document.body.append(rendered.container);

    rendered.container.click();
    await Promise.resolve();
    expect(store.getVaultSettings().startupTool).toBe("arrow");

    confirmMock.mockResolvedValue(true);
    rendered.container.click();
    await vi.waitFor(() => expect(store.getVaultSettings()).toEqual(createBuiltInSettings()));
    expect(device.value).toEqual(createBuiltInDeviceSettings());
    rendered.cleanup();
    rendered.container.remove();
  });
});
