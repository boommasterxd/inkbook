// @vitest-environment happy-dom

import { beforeAll, describe, expect, it, vi } from "vitest";

import { InkbookSettingsStore } from "../../../../src/obsidian/settings/storage";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import {
  control,
  createTab,
  DeviceAdapter,
  groups,
  renderDefinition,
  renderTool,
  requiredElement,
  requiredRender,
  renders,
  VaultAdapter,
} from "./setting-tab-fixture";

beforeAll(() => {
  installObsidianDomHelpers();
});

describe("InkbookSettingTab tool disclosures", () => {
  it("renders a title and right-side chevron with accessible independent panels", () => {
    const store = new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter());
    const tab = createTab(store);
    const rectangle = renderTool(tab, "Shapes and structures", "Rectangle");
    const line = renderTool(tab, "Shapes and structures", "Line");
    const rectangleTrigger = requiredElement<HTMLButtonElement>(
      rectangle.container,
      ".inkbook-settings-tool-trigger",
    );
    const rectanglePanel = requiredElement<HTMLElement>(
      rectangle.container,
      ".inkbook-settings-tool-panel",
    );
    const lineTrigger = requiredElement<HTMLButtonElement>(
      line.container,
      ".inkbook-settings-tool-trigger",
    );
    const linePanel = requiredElement<HTMLElement>(line.container, ".inkbook-settings-tool-panel");

    expect(rectangleTrigger.firstElementChild).toMatchObject({
      className: "inkbook-settings-tool-title",
      textContent: "Rectangle",
    });
    expect(rectangleTrigger.lastElementChild?.className).toBe("inkbook-settings-tool-chevron");
    expect(rectangleTrigger.lastElementChild?.querySelector("svg")?.dataset.icon).toBe(
      "chevron-right",
    );
    expect(rectangleTrigger.getAttribute("aria-controls")).toBe(rectanglePanel.id);
    expect(rectangleTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(rectanglePanel.hidden).toBe(true);

    rectangleTrigger.click();
    expect(rectangleTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(rectanglePanel.hidden).toBe(false);
    expect(lineTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(linePanel.hidden).toBe(true);

    lineTrigger.click();
    expect(rectanglePanel.hidden).toBe(false);
    expect(linePanel.hidden).toBe(false);
    rectangleTrigger.click();
    expect(rectanglePanel.hidden).toBe(true);
    expect(linePanel.hidden).toBe(false);
    rectangle.cleanup();
    line.cleanup();
  });
});

describe("InkbookSettingTab recognizable tool controls", () => {
  it("renders recognizable rectangle controls and persists a visual choice", async () => {
    const store = new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter());
    const rendered = renderTool(createTab(store), "Shapes and structures", "Rectangle");
    const outlineColor = control(rendered.container, "outline-color");
    const outlineWidth = control(rendered.container, "outline-width");
    const outlineStyle = control(rendered.container, "outline-style");
    const outlineOpacity = control(rendered.container, "outline-opacity");
    const fillColor = control(rendered.container, "fill-color");
    const fillOpacity = control(rendered.container, "fill-opacity");

    expect(outlineColor.querySelectorAll(".inkbook-menu-color-swatch")).toHaveLength(10);
    expect(outlineWidth.querySelectorAll(".inkbook-menu-width-choice")).toHaveLength(5);
    expect(outlineStyle.querySelectorAll("button")).toHaveLength(3);
    expect(outlineStyle.querySelectorAll(".inkbook-menu-line-preview")).toHaveLength(3);
    expect(
      outlineOpacity.querySelectorAll("input[type='range'], input[type='number']"),
    ).toHaveLength(2);
    expect(fillColor.querySelectorAll(".inkbook-menu-color-swatch")).toHaveLength(11);
    expect(fillOpacity.querySelectorAll("input[type='range'], input[type='number']")).toHaveLength(
      2,
    );

    outlineWidth.querySelector<HTMLButtonElement>("button[data-value='8']")?.click();
    await vi.waitFor(() =>
      expect(store.getVaultSettings().toolDefaults.shapes.rectangle.outlineWidth).toBe(8),
    );

    const ids = [...rendered.container.querySelectorAll<HTMLElement>("[id]")].map(
      (element) => element.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const input of rendered.container.querySelectorAll<HTMLElement>("button, input")) {
      const describedBy = input.getAttribute("aria-describedby");
      expect(describedBy).not.toBeNull();
      for (const id of describedBy?.split(" ") ?? []) {
        expect(rendered.container.querySelector(`#${id}`)).not.toBeNull();
      }
    }
    rendered.cleanup();
  });

  it("renders recognizable structural, node, stepper, and eraser controls", () => {
    const tab = createTab(new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter()));
    const arrow = renderTool(tab, "Shapes and structures", "Arrow");
    const coordinate = renderTool(tab, "Shapes and structures", "Coordinate system");
    const table = renderTool(tab, "Shapes and structures", "Table");
    const eraser = renderTool(tab, "Drawing tools", "Eraser");

    expect(control(arrow.container, "arrow-start-node").querySelectorAll("button")).toHaveLength(5);
    expect(control(arrow.container, "arrow-end-node").querySelectorAll("button")).toHaveLength(5);
    expect(
      control(coordinate.container, "coordinate-dimension").querySelectorAll("button"),
    ).toHaveLength(2);
    const tableColumns = control(table.container, "table-columns");
    expect(tableColumns.querySelectorAll(".inkbook-menu-stepper-button")).toHaveLength(2);
    expect(tableColumns.querySelector("output")?.textContent).toBe("3");
    const eraserRadius = control(eraser.container, "eraser-radius");
    expect(eraserRadius.querySelectorAll("input[type='range'], input[type='number']")).toHaveLength(
      2,
    );
    expect(eraserRadius.querySelector<HTMLInputElement>("input[type='range']")).toMatchObject({
      min: "8",
      max: "64",
      step: "4",
    });
    arrow.cleanup();
    coordinate.cleanup();
    table.cleanup();
    eraser.cleanup();
  });
});

describe("InkbookSettingTab settings validation", () => {
  it("rejects invalid numeric input and recovers from a persistence failure", async () => {
    const vault = new VaultAdapter();
    const store = new InkbookSettingsStore(vault, new DeviceAdapter());
    const tab = createTab(store);
    const eraser = renderTool(tab, "Drawing tools", "Eraser");
    const radius = control(eraser.container, "eraser-radius");
    const radiusField = requiredElement<HTMLInputElement>(radius, "input[type='number']");
    const originalRadius = store.getVaultSettings().toolDefaults.eraser.radius;

    radiusField.value = "100";
    radiusField.dispatchEvent(new Event("change"));

    expect(radiusField.value).toBe(String(originalRadius));
    expect(radius.querySelector(".inkbook-settings-control-error")?.textContent).toBe(
      "Enter a valid setting value.",
    );
    expect(store.getVaultSettings().toolDefaults.eraser.radius).toBe(originalRadius);

    vault.failure = new Error("Save failed");
    const rectangle = renderTool(tab, "Shapes and structures", "Rectangle");
    control(rectangle.container, "outline-width")
      .querySelector<HTMLButtonElement>("button[data-value='8']")
      ?.click();
    await vi.waitFor(() =>
      expect(
        control(rectangle.container, "outline-width").querySelector(
          ".inkbook-settings-control-error",
        )?.textContent,
      ).toBe("The setting could not be saved."),
    );
    expect(store.getVaultSettings().toolDefaults.shapes.rectangle.outlineWidth).not.toBe(8);
    expect(
      control(rectangle.container, "outline-width")
        .querySelector<HTMLButtonElement>("button[data-value='8']")
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    eraser.cleanup();
    rectangle.cleanup();
  });
});

describe("InkbookSettingTab page defaults", () => {
  it("renders recognizable background choices and a synchronized page-buffer input pair", async () => {
    const tab = createTab(new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter()));
    const group = groups(tab).find((candidate) => candidate.heading === "Page defaults");
    if (group === undefined) throw new Error("Missing Page defaults group.");
    const definitions = renders(group);
    const background = renderDefinition(requiredRender(definitions, "Background"));
    const buffer = renderDefinition(requiredRender(definitions, "Page buffer"));

    const backgroundChoices = background.container.querySelectorAll<HTMLButtonElement>(
      ".inkbook-menu-background-choice",
    );
    expect([...backgroundChoices].map((button) => button.dataset.backgroundType)).toEqual([
      "none",
      "lines",
      "dots",
      "squares",
    ]);
    expect(backgroundChoices).toHaveLength(4);
    expect(background.container.querySelector(".inkbook-menu-background-spacing")).not.toBeNull();
    const bufferControl = control(buffer.container, "active-buffer-lines");
    expect(
      bufferControl.querySelectorAll("input[type='range'], input[type='number']"),
    ).toHaveLength(2);
    const range = bufferControl.querySelector<HTMLInputElement>("input[type='range']");
    const number = bufferControl.querySelector<HTMLInputElement>("input[type='number']");
    if (range === null || number === null) throw new Error("Missing page-buffer input pair.");
    range.value = "5";
    range.dispatchEvent(new Event("input"));
    expect(number.value).toBe("5");
    number.value = "6";
    number.dispatchEvent(new Event("input"));
    expect(range.value).toBe("6");
    number.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(tab.getControlValue("pageDefaults.activeBufferLines")).toBe(6));
    background.cleanup();
    buffer.cleanup();
  });

  it("restores the persisted background after a save failure", async () => {
    const vault = new VaultAdapter();
    vault.failure = new Error("Save failed");
    const tab = createTab(new InkbookSettingsStore(vault, new DeviceAdapter()));
    const group = groups(tab).find((candidate) => candidate.heading === "Page defaults");
    if (group === undefined) throw new Error("Missing Page defaults group.");
    const background = renderDefinition(requiredRender(renders(group), "Background"));

    background.container
      .querySelector<HTMLButtonElement>("button[data-background-type='dots']")
      ?.click();

    await vi.waitFor(() =>
      expect(
        background.container.querySelector(".inkbook-settings-control-error")?.textContent,
      ).toBe("The background default could not be saved."),
    );
    expect(
      background.container
        .querySelector<HTMLButtonElement>("button[data-background-type='squares']")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(tab.getControlValue("pageDefaults.backgroundType")).toBe("squares");
    background.cleanup();
  });
});
