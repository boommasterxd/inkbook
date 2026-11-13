// @vitest-environment happy-dom

import { beforeAll, describe, expect, it, vi } from "vitest";

import { type SettingDefinitionItem, type SettingDefinitionRender } from "obsidian";

import type { SettingsControlKey } from "../../../../src/obsidian/settings/control-values";
import { InkbookSettingsStore } from "../../../../src/obsidian/settings/storage";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { labelledByElements } from "../../../fixtures/accessibility";
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
  rendered.container.querySelector<HTMLButtonElement>(".inkbook-settings-tool-trigger")?.click();
  const labels = [
    ...rendered.container.querySelectorAll(
      ".inkbook-settings-tool-title, .inkbook-menu-control-header, .inkbook-menu-toggle-heading",
    ),
  ].flatMap((element) => {
    const title = element.matches(".inkbook-menu-control-header")
      ? labelledByElements(element.parentElement!)[0]!
      : element;
    return title.textContent === null ? [] : [title.textContent];
  });
  rendered.cleanup();
  return labels;
}

function isRenderDefinition(
  definition: SettingDefinitionItem<SettingsControlKey>,
): definition is SettingDefinitionRender {
  return "render" in definition && typeof definition.render === "function";
}

describe("InkbookSettingTab group definitions and reset actions", () => {
  it("returns the required groups in order without storage access", () => {
    const vault = new VaultAdapter();
    const device = new DeviceAdapter();
    const tab = createTab(new InkbookSettingsStore(vault, device));

    const definitions = tab.getControlDefinitions();

    expect(groups(tab).map((group) => group.heading)).toEqual([
      "General",
      "Appearance",
      "Performance",
      "Page defaults",
      "Drawing tools",
      "Shapes and structures",
      "Snapping",
      "Input",
      "Hold to shape",
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
    const definitions = tab.getControlDefinitions();
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
});

describe("InkbookSettingTab general, appearance and tool controls", () => {
  it("exposes structural pages and conditional folder rows", async () => {
    const store = new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter());
    const tab = createTab(store);
    const general = groups(tab)[0];
    expect(general).toBeDefined();
    expect(general?.items?.map((item) => item.name)).toEqual([
      "Startup tool",
      "File placement",
      "Custom vault folder",
      "Create custom folder",
      "Copy text fields as text",
      "Reset group to defaults",
    ]);
    const appearance = groups(tab).find((group) => group.heading === "Appearance");
    expect(appearance?.items?.map((item) => item.name)).toEqual([
      "Language",
      "Left-handed toolbar",
      "Motion",
      "Reset group to defaults",
    ]);
    const performance = groups(tab).find((group) => group.heading === "Performance");
    expect(performance?.items?.map((item) => item.name)).toEqual([
      "Display refresh rate",
      "Scroll preload margin",
      "Selection highlights",
      "Reset group to defaults",
    ]);
    const highlights = performance?.items?.find((item) => item.name === "Selection highlights");
    expect(highlights).toMatchObject({
      control: { type: "toggle", key: "selectionHighlightsEnabled" },
    });
    expect(highlights?.desc).toContain("affect performance, especially for large selections");
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

describe("InkbookSettingTab import action", () => {
  it("places import history below the optional start action", () => {
    const openInkImport = vi
      .fn<(ownerWindow: Window | null) => Promise<void>>()
      .mockResolvedValue();
    const tab = createTab(
      new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter()),
      undefined,
      {
        open: openInkImport,
        history: vi.fn().mockResolvedValue([]),
        subscribe: () => () => undefined,
      },
    );
    const importGroup = groups(tab).find((group) => group.heading === "Import");

    expect(importGroup?.items?.map((item) => item.name)).toEqual([
      "Start import",
      "Import history",
    ]);
    const action = importGroup?.items?.find(isRenderDefinition);
    expect(action?.desc).toContain("Obsidian Ink");
    if (action === undefined) throw new Error("Missing Obsidian Ink import action.");

    const rendered = renderDefinition(action);
    rendered.container.click();

    expect(openInkImport).toHaveBeenCalledWith(window, undefined, expect.any(AbortSignal));
    rendered.cleanup();
  });
});

describe("InkbookSettingTab input definitions", () => {
  it("presents pen-tap insertion as the same toggle control as finger drawing", () => {
    const tab = createTab(new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter()));
    const input = groups(tab).find((group) => group.heading === "Input");
    const controls = input?.items?.filter((item) => "control" in item) ?? [];

    expect(controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          control: { key: "device.fingerDrawingEnabled", type: "toggle" },
          name: "Finger drawing",
        }),
        expect.objectContaining({
          control: { key: "device.penTapInsertionEnabled", type: "toggle" },
          name: "Pen-tap insertion",
        }),
      ]),
    );
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
    const detectingRate = groups(detectingTab)
      .find((group) => group.heading === "Performance")
      ?.items?.find((item) => item.name === "Display refresh rate");
    const tab = createTab(store, () => ({ kind: "detected", refreshRate: 144 }));
    const refreshRate = groups(tab)
      .find((group) => group.heading === "Performance")
      ?.items?.find((item) => item.name === "Display refresh rate");
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
    expect(refreshRate.desc).toContain(
      "Detected 144 Hz for this Obsidian window. Other windows are measured independently.",
    );
    expect(refreshRate.desc).toContain("loading can take longer");
    expect(detectingRate.desc).toContain("120 Hz profile until detection completes");
  });
});

describe("InkbookSettingTab visible labels", () => {
  it("uses sentence case for every multi-word designation", () => {
    const tab = createTab(new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter()));
    const definitions = tab.getControlDefinitions();
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
