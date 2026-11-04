// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../../src/domain/settings";
import { createToolStyleControls } from "../../../../src/obsidian/menus/tool-style-controls";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { installNativeMenuMeasurementStyles } from "../../../adapters/obsidian/editor-toolbar-menu";
import { assertAccessibleSemantics } from "../../../fixtures/accessibility";
import { createOwnedToolbarMenuFixture } from "../../../fixtures/obsidian/owned-toolbar-menu";
import { createGeometryMenuContent } from "../../../../src/obsidian/menus/geometry-menu-content";

beforeEach(() => {
  installObsidianDomHelpers();
  installNativeMenuMeasurementStyles();
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();
  Platform.isMobile = false;
  Platform.isPhone = false;
  vi.restoreAllMocks();
});

function mountMenu(initialMenu: "overflow" | "shape" | "style") {
  return createOwnedToolbarMenuFixture({
    initialMenu,
    motion: "reduced",
    state: { styleControls: createToolStyleControls(createBuiltInSettings().toolDefaults, "draw") },
  }).session;
}

describe.each([false, true])("owned menu semantic accessibility, phone=%s", (phone) => {
  beforeEach(() => {
    Platform.isMobile = phone;
    Platform.isPhone = phone;
  });

  it("labels geometry operations, step sizes and discrete direction controls", async () => {
    const onStep = vi.fn();
    const content = createGeometryMenuContent({
      ownerDocument: document,
      operations: [
        { value: -1, label: "Move" },
        { value: 1, label: "Rotate" },
      ],
      onOperation: vi.fn(),
      onStep,
      renderIcon: vi.fn(),
    });
    const surface = document.body.createDiv();
    surface.append(content.fragment);
    await assertAccessibleSemantics(surface, [
      "button-name",
      "select-name",
      "aria-valid-attr-value",
    ]);
    surface
      .querySelector<HTMLButtonElement>('[aria-label="10 document units or degrees"]')!
      .click();
    content.operation.value = "1";
    surface.querySelector<HTMLButtonElement>('[aria-label="Left"]')!.click();
    expect(onStep).toHaveBeenCalledWith(1, { x: -10, y: 0 });
  });

  it.each(["overflow", "shape", "style"] as const)("scans the open %s surface", async (menu) => {
    const session = mountMenu(menu);
    try {
      const surface = document.querySelector<HTMLElement>('[role="menu"], [role="dialog"]');
      expect(surface).not.toBeNull();
      if (menu === "overflow" || menu === "style") {
        const labelledElements = [...surface!.querySelectorAll<HTMLElement>("[aria-label]")];
        expect(surface!.hasAttribute("aria-label")).toBe(false);
        const label = document.getElementById(surface!.getAttribute("aria-labelledby")!);
        expect(label?.textContent).toBe(menu === "style" ? "Style" : "Menu");
        for (const element of labelledElements) {
          expect(element.getAttribute("aria-label")).not.toBe("");
          expect(element.getAttribute("data-tooltip-delay")).toBe("700");
          expect(element.hasAttribute("title")).toBe(false);
        }
      }
      if (menu === "style") {
        const choices = surface!.querySelector<HTMLElement>('[data-control="color"]');
        expect(choices?.getAttribute("role")).toBe("group");
        const label = document.getElementById(choices!.getAttribute("aria-labelledby")!);
        expect(label?.textContent).toBe("Color");
        expect(choices?.querySelector('[aria-label="Red"]')).not.toBeNull();
      }
      await assertAccessibleSemantics(surface!, [
        menu === "style"
          ? "button-name"
          : menu === "shape"
            ? "aria-toggle-field-name"
            : "aria-command-name",
        "aria-valid-attr-value",
      ]);
    } finally {
      session.close("immediate");
    }
  });

  it("scans Background after navigating from Overflow", async () => {
    const session = mountMenu("overflow");
    try {
      const background = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent === "Background",
      );
      expect(background).toBeDefined();
      background!.click();
      await Promise.resolve();
      const panel = document.querySelector<HTMLElement>('.inkbook-adaptive-panel[role="dialog"]');
      expect(panel).not.toBeNull();
      await assertAccessibleSemantics(panel!, ["aria-dialog-name", "button-name", "label"]);
    } finally {
      session.close("immediate");
    }
  });
});
