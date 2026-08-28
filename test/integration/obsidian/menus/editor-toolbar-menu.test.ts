// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import {
  EditorToolbarMenuSession,
  menuPositionBelow,
  populateNativeToolbarMenu,
  type MenuFactoryPort,
} from "../../../../src/obsidian/menus";
import {
  activeShapeIconId,
  BACKGROUND_SQUARES_ICON_ID,
  OPACITY_ICON_ID,
  PRESSURE_SENSITIVITY_ICON_ID,
} from "../../../../src/rendering/ui/icon-ids";
import { createHtmlElement, installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import {
  createEditorToolbarMenuOptions as options,
  FakeEditorToolbarMenu as FakeMenu,
  installNativeMenuMeasurementStyles,
  menuAction as action,
  menuTitles as titles,
} from "../../../adapters/obsidian/editor-toolbar-menu";

beforeEach(() => {
  installObsidianDomHelpers();
  Platform.isMobile = false;
  Platform.isPhone = false;
  installNativeMenuMeasurementStyles();
});

afterEach(() => {
  Platform.isMobile = false;
  Platform.isPhone = false;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("native editor toolbar menus", () => {
  it("keeps Overflow entirely native while drilling into Background", () => {
    const menu = new FakeMenu();
    const navigate = vi.fn();
    populateNativeToolbarMenu(menu, "overflow", options(), navigate);

    expect(titles(menu)).toEqual([
      "Background",
      "Bring forward",
      "Send backward",
      "Bring to front",
      "Send to back",
      "Copy embed",
      "Erase all",
      "Delete embed",
    ]);
    expect(action(menu, "Background").icon).toBe(BACKGROUND_SQUARES_ICON_ID);
    expect(
      action(menu, "Erase all").fragment?.querySelector(
        '.inkbook-menu-title-content[data-tone="caution"]',
      )?.textContent,
    ).toBe("Erase all");
    expect(action(menu, "Delete embed").warning).toBe(true);
    expect(
      menu.entries.every(
        (entry) =>
          entry === "separator" || entry.title === "Erase all" || entry.fragment === undefined,
      ),
    ).toBe(true);
    action(menu, "Background").click?.();
    expect(navigate).toHaveBeenCalledWith("background");
  });

  it("keeps Shape native with host-owned checked and separator states", () => {
    const menu = new FakeMenu();
    const configured = options({
      selectedShape: "arrow",
      shapeIcon: {
        arrowEnd: "diamond",
        arrowStart: "circle",
        coordinateDimension: "3d",
      },
    });
    populateNativeToolbarMenu(menu, "shape", configured, vi.fn());

    expect(action(menu, "Arrow").checked).toBe(true);
    expect(action(menu, "Arrow").icon).toBe(
      activeShapeIconId("arrow", configured.getState().shapeIcon),
    );
    expect(action(menu, "Coordinate system").icon).toBe(
      activeShapeIconId("coordinate-system", configured.getState().shapeIcon),
    );
    expect(menu.entries.filter((entry) => entry === "separator")).toHaveLength(2);
    expect(
      menu.entries.every((entry) => entry === "separator" || entry.fragment === undefined),
    ).toBe(true);
  });

  it("uses native placement without forcing a custom width", () => {
    const anchor = createHtmlElement("button");
    anchor.getBoundingClientRect = () =>
      ({ bottom: 148, height: 44, left: 320, right: 364, top: 104, width: 44 }) as DOMRect;

    expect(menuPositionBelow(anchor, "overflow", ["Delete embed"])).toEqual({
      overlap: true,
      width: 44,
      x: 270,
      y: 150,
    });
    expect(menuPositionBelow(anchor, "overflow")).toEqual({
      overlap: true,
      width: 44,
      x: 320,
      y: 150,
    });
    expect(menuPositionBelow(anchor, "shape")).toEqual({ overlap: true, x: 320, y: 150 });
    Platform.isMobile = true;
    document.body.setCssProps({ "--icon-s": "18px" });
    expect(menuPositionBelow(anchor, "overflow", ["Delete embed"])).toEqual({
      overlap: true,
      width: 44,
      x: 265,
      y: 148,
    });
    expect(menuPositionBelow(anchor, "shape")).toEqual({ overlap: true, x: 320, y: 148 });
    Platform.isPhone = true;
    expect(menuPositionBelow(anchor, "overflow")).toEqual({ overlap: true, x: 320, y: 150 });
  });
});

describe("phone native toolbar menu spacing", () => {
  it("uses and releases a minimum safe area without changing native menu entries", () => {
    Platform.isPhone = true;
    document.body.setCssProps({ "--safe-area-inset-bottom": "0px", "--size-4-4": "16px" });
    const menus: FakeMenu[] = [];
    const configured = connectedOptions();
    new EditorToolbarMenuSession({
      ...configured,
      factory: recordingFactory(menus),
      initialMenu: "overflow",
    });

    expect(document.body.style.getPropertyValue("--safe-area-inset-bottom")).toBe("16px");
    expect(titles(menus[0]!)).not.toContain("");
    menus[0]?.hide();
    expect(document.body.style.getPropertyValue("--safe-area-inset-bottom")).toBe("0px");
  });
});

describe("Style AdaptivePanel", () => {
  it("opens without an Obsidian Menu and keeps number input and slider synchronized", () => {
    const menus: FakeMenu[] = [];
    const configured = connectedOptions({
      styleControls: [
        {
          id: "opacity",
          kind: "number",
          label: "Opacity",
          max: 1,
          min: 0,
          step: 0.05,
          value: 0.65,
        },
        {
          checked: true,
          id: "pressure-enabled",
          kind: "toggle",
          label: "Pressure sensitivity",
        },
      ],
    });
    const session = new EditorToolbarMenuSession({
      ...configured,
      factory: recordingFactory(menus),
      initialMenu: "style",
    });

    expect(menus).toHaveLength(0);
    const panel = document.querySelector<HTMLElement>('.inkbook-adaptive-panel[data-kind="style"]');
    const range = panel?.querySelector<HTMLInputElement>('input[type="range"]');
    const value = panel?.querySelector<HTMLInputElement>('input[type="number"]');
    expect(range?.value).toBe("65");
    expect(value?.value).toBe("65");
    expect(value?.getAttribute("aria-label")).toBe("Opacity percent");
    expect(panel?.querySelector(".inkbook-menu-value-suffix")?.textContent).toBe("%");
    expect(
      panel?.querySelector('[data-control="opacity"] [data-icon]')?.getAttribute("data-icon"),
    ).toBe(OPACITY_ICON_ID);
    expect(
      panel
        ?.querySelector('[data-control="pressure-enabled"] [data-icon]')
        ?.getAttribute("data-icon"),
    ).toBe(PRESSURE_SENSITIVITY_ICON_ID);

    value!.value = "72";
    value!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(range?.value).toBe("72");
    value!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(configured.handlers.onStyleChange).toHaveBeenCalledWith("opacity", 0.72);
    session.close("immediate");
  });
});

describe("Background AdaptivePanel navigation", () => {
  it("moves from native Overflow into one owned panel and returns to native Overflow", async () => {
    const menus: FakeMenu[] = [];
    const factory = recordingFactory(menus);
    const base = connectedOptions();
    let background = base.getState().background;
    const configured = {
      ...base,
      factory,
      getState: () => ({ ...base.getState(), background }),
      handlers: {
        ...base.handlers,
        onBackgroundTypeChange: vi.fn((type: typeof background.type) => {
          background = type === "none" ? { spacing: null, type } : { spacing: "l", type };
        }),
      },
      initialMenu: "overflow" as const,
    };
    const session = new EditorToolbarMenuSession(configured);

    action(menus[0]!, "Background").click?.();
    await Promise.resolve();
    expect(menus).toHaveLength(1);
    const panel = document.querySelector<HTMLElement>(
      '.inkbook-adaptive-panel[data-kind="background"]',
    );
    expect(panel).not.toBeNull();
    expect(
      panel?.querySelector('[data-background-type="squares"]')?.getAttribute("aria-pressed"),
    ).toBe("true");

    panel?.querySelector<HTMLButtonElement>('[data-background-type="lines"]')?.click();
    expect(configured.handlers.onBackgroundTypeChange).toHaveBeenCalledWith("lines");
    expect(panel?.querySelector<HTMLInputElement>('input[type="range"]')?.value).toBe("2");
    expect(
      document.querySelector('.inkbook-adaptive-panel[data-kind="background"]'),
    ).not.toBeNull();

    panel?.querySelector<HTMLElement>(".inkbook-adaptive-panel-back")?.click();
    await Promise.resolve();
    expect(document.querySelector(".inkbook-adaptive-panel")).toBeNull();
    expect(menus).toHaveLength(2);
    expect(titles(menus[1]!)).toContain("Background");
    expect(configured.onClosed).not.toHaveBeenCalled();
    session.close("immediate");
  });

  it("keeps spacing preview and commit inside the open panel", async () => {
    const menus: FakeMenu[] = [];
    const configured = connectedOptions();
    const session = new EditorToolbarMenuSession({
      ...configured,
      factory: recordingFactory(menus),
      initialMenu: "overflow",
    });
    action(menus[0]!, "Background").click?.();
    await Promise.resolve();
    const range = document.querySelector<HTMLInputElement>(
      '.inkbook-adaptive-panel[data-kind="background"] input[type="range"]',
    );
    range!.value = "3";
    range!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(configured.handlers.onBackgroundSpacingPreview).toHaveBeenCalledWith("xl");
    expect(configured.handlers.onBackgroundSpacingChange).not.toHaveBeenCalled();
    range!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(configured.handlers.onBackgroundSpacingChange).toHaveBeenCalledWith("xl");
    expect(document.querySelector(".inkbook-adaptive-panel")).not.toBeNull();
    session.close("immediate");
  });

  it("uses the same panel foundation as a phone bottom sheet", () => {
    Platform.isPhone = true;
    const configured = connectedOptions();
    const session = new EditorToolbarMenuSession({ ...configured, initialMenu: "style" });

    expect(
      document.querySelector(".inkbook-adaptive-panel-layer")?.getAttribute("data-platform"),
    ).toBe("phone");
    expect(document.querySelector(".inkbook-adaptive-panel")?.getAttribute("aria-modal")).toBe(
      "true",
    );
    session.close("immediate");
  });
});

function connectedOptions(overrides = {}) {
  const configured = options(overrides);
  const root = createHtmlElement("div");
  root.className = "inkbook-root";
  root.dataset.inkbookMotion = "reduced";
  root.append(configured.anchor, configured.canvasInputSurface as HTMLElement);
  document.body.append(root);
  return configured;
}

function recordingFactory(menus: FakeMenu[]): MenuFactoryPort {
  return {
    create: () => {
      const menu = new FakeMenu();
      menus.push(menu);
      return menu;
    },
    forEvent: () => new FakeMenu(),
  };
}
