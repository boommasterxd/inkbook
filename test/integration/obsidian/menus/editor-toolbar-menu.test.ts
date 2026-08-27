// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EditorToolbarMenuSession,
  menuPositionBelow,
  populateToolbarMenu,
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
  menuAction as action,
  menuTitles as titles,
  type RecordedMenuItem as RecordedItem,
} from "../../../adapters/obsidian/editor-toolbar-menu";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

beforeEach(installObsidianDomHelpers);

describe("adaptive editor toolbar menus", () => {
  it("groups overflow actions, gives every entry an icon, and drills into Background", () => {
    const menu = new FakeMenu();
    const navigate = vi.fn();
    populateToolbarMenu(menu, "overflow", options(), navigate);

    expect(titles(menu)).toEqual([
      "Background",
      "Arrange",
      "Bring forward",
      "Send backward",
      "Bring to front",
      "Send to back",
      "Copy embed",
      "Erase all",
      "Delete embed",
    ]);
    expect(action(menu, "Background").icon).toBe(BACKGROUND_SQUARES_ICON_ID);
    action(menu, "Background").click?.();
    expect(navigate).toHaveBeenCalledWith("background");
    for (const entry of menu.entries) {
      if (entry !== "separator") expect(entry.icon).toBeTruthy();
    }
    expect(action(menu, "Erase all").warning).toBeUndefined();
    expect(action(menu, "Erase all").icon).toBe("inkbook-eraser-caution");
    expect(
      action(menu, "Erase all").fragment?.querySelector(".inkbook-menu-title-content-caution"),
    ).not.toBeNull();
    expect(action(menu, "Delete embed").warning).toBe(true);
  });

  it.each([
    ["none", null, "ban"],
    ["lines", "m", "align-justify"],
    ["dots", "m", "grip"],
    ["squares", "m", BACKGROUND_SQUARES_ICON_ID],
  ] as const)("shows the active %s pattern on the Background entry", (type, spacing, icon) => {
    const menu = new FakeMenu();
    populateToolbarMenu(menu, "overflow", options({ background: { spacing, type } }), vi.fn());

    expect(action(menu, "Background").icon).toBe(icon);
  });
});

describe("adaptive background menu", () => {
  it("exposes reachable Background choices and maps the four-step spacing slider", () => {
    const menu = new FakeMenu();
    const navigate = vi.fn();
    const configured = options();
    const handlers = configured.handlers;
    populateToolbarMenu(menu, "background", configured, navigate);

    expect(titles(menu)).toEqual(["Back", "None", "Lines", "Dots", "Squares"]);
    expect(action(menu, "Squares").icon).toBe(BACKGROUND_SQUARES_ICON_ID);
    expect(action(menu, "Squares").checked).toBe(true);
    action(menu, "Back").click?.();
    expect(navigate).toHaveBeenCalledWith("overflow");
    action(menu, "Lines").click?.();
    expect(handlers.onBackgroundTypeChange).toHaveBeenCalledWith("lines");
    expect(navigate).toHaveBeenCalledWith("background");
    const spacing = menu.entries.find(
      (entry): entry is RecordedItem =>
        entry !== "separator" &&
        entry.fragment?.querySelector('input[type="range"]') !== null &&
        entry.fragment?.querySelector('input[type="range"]') !== undefined,
    )?.fragment;
    const range = spacing?.querySelector<HTMLInputElement>('input[type="range"]');
    expect(range?.value).toBe("1");
    expect(range?.getAttribute("aria-valuetext")).toBe("Medium");
    const pointerDown = vi.fn();
    const mouseDown = vi.fn();
    const click = vi.fn();
    spacing?.addEventListener("pointerdown", pointerDown);
    spacing?.addEventListener("mousedown", mouseDown);
    spacing?.addEventListener("click", click);
    range!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    range!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    range!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(pointerDown).toHaveBeenCalledOnce();
    expect(mouseDown).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    range!.value = "3";
    range!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(handlers.onBackgroundSpacingChange).not.toHaveBeenCalled();
    expect(handlers.onBackgroundSpacingPreview).toHaveBeenCalledOnce();
    expect(handlers.onBackgroundSpacingPreview).toHaveBeenCalledWith("xl");
    expect(spacing?.querySelector("output")?.textContent).toBe("XL");
    range!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(handlers.onBackgroundSpacingChange).toHaveBeenCalledOnce();
    expect(handlers.onBackgroundSpacingChange).toHaveBeenCalledWith("xl");
  });

  it("omits the spacing slider for a background without guides", () => {
    const menu = new FakeMenu();
    populateToolbarMenu(
      menu,
      "background",
      options({ background: { spacing: null, type: "none" } }),
      vi.fn(),
    );

    expect(
      menu.entries.some((entry) => entry !== "separator" && entry.fragment !== undefined),
    ).toBe(true);
    expect(
      menu.entries.some(
        (entry) =>
          entry !== "separator" &&
          entry.fragment?.querySelector('input[type="range"]') !== null &&
          entry.fragment?.querySelector('input[type="range"]') !== undefined,
      ),
    ).toBe(false);
  });
});

describe("adaptive shape menu", () => {
  it("shows checked shape entries with dynamic arrow endpoints and coordinate axes", () => {
    const menu = new FakeMenu();
    const configured = options({
      selectedShape: "arrow",
      shapeIcon: {
        arrowEnd: "diamond",
        arrowStart: "circle",
        coordinateDimension: "3d",
      },
    });
    populateToolbarMenu(menu, "shape", configured, vi.fn());

    expect(action(menu, "Arrow").checked).toBe(true);
    expect(action(menu, "Arrow").icon).toBe(
      activeShapeIconId("arrow", configured.getState().shapeIcon),
    );
    expect(action(menu, "Coordinate system").icon).toBe(
      activeShapeIconId("coordinate-system", configured.getState().shapeIcon),
    );
    expect(titles(menu)).toEqual([
      "Line",
      "Arrow",
      "Rectangle",
      "Ellipse",
      "Triangle",
      "Octagon",
      "Parallelogram",
      "Diamond",
      "Coordinate system",
      "Table",
    ]);
    expect(menu.entries.filter((entry) => entry === "separator")).toHaveLength(2);
    for (const entry of menu.entries) {
      if (entry !== "separator") expect(entry.icon).toBeTruthy();
    }
  });
});

describe("adaptive style menu", () => {
  it("renders compact interactive style controls with opacity slider and percentage field", () => {
    const menu = new FakeMenu();
    const configured = options({
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
          id: "outline-opacity",
          kind: "number",
          label: "Outline opacity",
          max: 1,
          min: 0,
          step: 0.05,
          value: 0.8,
        },
        {
          id: "fill-opacity",
          kind: "number",
          label: "Fill opacity",
          max: 1,
          min: 0,
          step: 0.05,
          value: 0.4,
        },
        {
          id: "outline-style",
          kind: "choice",
          label: "Outline style",
          options: [
            { label: "Solid", value: "solid" },
            { label: "Dashed", value: "dashed" },
          ],
          value: "dashed",
        },
      ],
    });
    populateToolbarMenu(menu, "style", configured, vi.fn());
    expect(titles(menu)).not.toContain("Style");
    const fragment = menu.entries.find(
      (entry): entry is RecordedItem => entry !== "separator" && entry.fragment !== undefined,
    )?.fragment;
    expect(fragment).toBeDefined();
    const range = fragment?.querySelector<HTMLInputElement>('input[type="range"]');
    const value = fragment?.querySelector<HTMLInputElement>('input[type="number"]');
    expect(range?.value).toBe("65");
    expect(range?.step).toBe("5");
    const mouseDown = vi.fn();
    fragment?.addEventListener("mousedown", mouseDown);
    range!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(mouseDown).not.toHaveBeenCalled();
    expect(value?.value).toBe("65");
    expect(value?.getAttribute("aria-label")).toBe("Opacity percent");
    for (const id of ["opacity", "outline-opacity", "fill-opacity"]) {
      expect(
        fragment?.querySelector(`[data-control="${id}"] [data-icon]`)?.getAttribute("data-icon"),
      ).toBe(OPACITY_ICON_ID);
    }
    expect(fragment?.querySelector('[aria-label="Dashed"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});

describe("adaptive pen style menu", () => {
  it("keeps five pen widths distinct and aligns pressure with its label", () => {
    const menu = new FakeMenu();
    const configured = options({
      styleControls: [
        {
          id: "stroke-width",
          kind: "choice",
          label: "Width",
          options: [
            { label: "XS", value: "2" },
            { label: "S", value: "4" },
            { label: "M", value: "8" },
            { label: "L", value: "14" },
            { label: "XL", value: "22" },
          ],
          value: "8",
        },
        {
          checked: true,
          id: "pressure-enabled",
          kind: "toggle",
          label: "Pressure sensitivity",
        },
      ],
    });
    populateToolbarMenu(menu, "style", configured, vi.fn());
    const fragment = menu.entries.find(
      (entry): entry is RecordedItem => entry !== "separator" && entry.fragment !== undefined,
    )?.fragment;
    const widthButtons = [...(fragment?.querySelectorAll(".inkbook-menu-width-choice") ?? [])];
    expect(widthButtons).toHaveLength(5);
    expect(widthButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "XS",
      "S",
      "M",
      "L",
      "XL",
    ]);
    expect(
      widthButtons.map((button) =>
        button
          .querySelector<HTMLElement>(".inkbook-menu-line-preview")
          ?.style.getPropertyValue("--inkbook-menu-line-width"),
      ),
    ).toEqual(["1px", "2.5px", "4px", "6px", "8px"]);

    const toggle = fragment?.querySelector<HTMLElement>(
      '[data-control="pressure-enabled"].inkbook-menu-toggle-row',
    );
    expect(toggle?.querySelector(".inkbook-menu-toggle-heading")?.textContent).toContain(
      "Pressure sensitivity",
    );
    expect(toggle?.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe(
      PRESSURE_SENSITIVITY_ICON_ID,
    );
    const input = toggle?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(input?.checked).toBe(true);
    input!.checked = false;
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(configured.handlers.onStyleChange).toHaveBeenCalledWith("pressure-enabled", false);
  });
});

describe("adaptive toolbar menu lifecycle", () => {
  it("keeps drill-in and Back navigation within one paint-contiguous live session", async () => {
    const menus: FakeMenu[] = [];
    const factory = recordingFactory(menus);
    const configured = options();
    new EditorToolbarMenuSession({ ...configured, factory, initialMenu: "overflow" });

    action(menus[0]!, "Background").click?.();
    expect(menus).toHaveLength(1);
    await Promise.resolve();
    expect(titles(menus[1]!)).toContain("Back");
    action(menus[1]!, "Back").click?.();
    expect(menus).toHaveLength(2);
    await Promise.resolve();
    expect(titles(menus[2]!)).toContain("Background");
    expect(configured.onClosed).not.toHaveBeenCalled();
  });

  it("centers each desktop menu below its trigger and returns focus without scrolling", () => {
    vi.useFakeTimers();
    const anchor = createHtmlElement("button");
    document.body.append(anchor);
    anchor.getBoundingClientRect = () =>
      ({ bottom: 148, height: 44, left: 320, right: 364, top: 104, width: 44 }) as DOMRect;
    const focus = vi.spyOn(anchor, "focus");
    const menus: FakeMenu[] = [];
    const factory = recordingFactory(menus);
    new EditorToolbarMenuSession({ ...options(), anchor, factory, initialMenu: "overflow" });

    expect(menus[0]?.parent).toBe(anchor);
    expect(menus[0]?.positions).toEqual([{ overlap: true, width: 199, x: 242.5, y: 154 }]);
    expect(menuPositionBelow(anchor, "overflow", document)).toEqual({
      overlap: true,
      width: 199,
      x: 242.5,
      y: 154,
    });
    expect(menuPositionBelow(anchor, "style", document)).toEqual({
      overlap: true,
      width: 364,
      x: 160,
      y: 154,
    });
    menus[0]?.hide();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

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
