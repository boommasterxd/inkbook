// @vitest-environment happy-dom
import { expect, it, onTestFinished, vi } from "vitest";
import { Localization } from "../../../../src/domain/localization";
import { BUILT_IN_COLOR_OPTIONS } from "../../../../src/domain/settings/color-palette";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { styleChange } from "../../../../src/obsidian/embeds/active-editor/controller-style-values";
import type { StyleControl } from "../../../../src/obsidian/menus/editor-menu-types";
import { createStyleMenuContent } from "../../../../src/obsidian/menus/style-menu-content";
import { createToolStyleControls } from "../../../../src/obsidian/menus/tool-style-controls";
import { serializeStyleColor } from "../../../../src/obsidian/menus/style-color-options";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

function fixture(tool: "draw" | "rectangle" = "draw") {
  installObsidianDomHelpers();
  const cleanups: (() => void)[] = [];
  const localization = new Localization();
  const controls = createToolStyleControls(createBuiltInSettings().toolDefaults, tool);
  const onChange = vi.fn<(controlId: string, value: boolean | number | string) => void>();
  let sync: (controls: readonly StyleControl[]) => void = () => undefined;
  const menu = document.createElement("div");
  const content = createStyleMenuContent({
    controls,
    localization,
    onChange,
    ownerDocument: document,
    renderIcon: () => undefined,
    registerCleanup: (cleanup) => cleanups.push(cleanup),
    registerLocaleUpdate: (update) => cleanups.push(localization.subscribe(update)),
    registerStyleSync: (update) => {
      sync = update;
    },
  });
  menu.append(content);
  document.body.append(menu);
  onTestFinished(() => {
    for (const cleanup of cleanups) cleanup();
    menu.remove();
  });
  return {
    localization,
    onChange,
    field: (id: string) => menu.querySelector<HTMLElement>(`[data-control="${id}"]`)!,
    sync: (id: string, value: string | null) =>
      sync(
        controls.map((control) =>
          control.id === id && control.kind === "choice"
            ? { ...control, value, mixed: value === null }
            : control,
        ),
      ),
  };
}

it("offers Auto and every fixed color directly and commits each through the style parser", () => {
  const f = fixture();
  const field = f.field("color");
  const buttons = [...field.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons).toHaveLength(20);
  for (const [index, { color }] of BUILT_IN_COLOR_OPTIONS.entries()) {
    const button = buttons[index]!;
    expect(button.getAttribute("aria-label")).not.toBe("");
    button.click();
    expect(styleChange(...f.onChange.mock.lastCall!)).toEqual({ property: "color", value: color });
    expect([...field.querySelectorAll('[aria-pressed="true"]')]).toEqual([button]);
  }
});

it("preserves direct neutral choices, mixed selection and live translated color names", () => {
  const f = fixture();
  const field = f.field("color");
  const white = field.querySelector<HTMLButtonElement>('[aria-label="White"]')!;
  const auto = field.querySelector<HTMLButtonElement>('[data-value="theme-text"]')!;
  expect(auto.getAttribute("aria-label")).toBe("Auto (follows Obsidian theme)");
  f.sync("color", "#FFFFFFFF");
  expect(white.getAttribute("aria-pressed")).toBe("true");
  f.localization.setLanguage("de");
  expect(white.getAttribute("aria-label")).toBe("Weiß");
  expect(auto.getAttribute("aria-label")).toBe("Auto (folgt dem Obsidian-Theme)");
  expect(field.querySelector('[aria-label="Hellgrau"]')).not.toBeNull();
  expect(field.querySelector('[aria-label="Dunkelgrau"]')).not.toBeNull();
  f.sync("color", null);
  expect(field.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
  white.focus();
  white.click();
  expect(document.activeElement).toBe(white);
  expect(f.onChange).toHaveBeenLastCalledWith("color", "#FFFFFFFF");
});

it("includes the complete palette in fills and keeps clearing separate and reversible", () => {
  const f = fixture("rectangle");
  const field = f.field("fill-color");
  const clear = field.querySelector<HTMLButtonElement>('[aria-label="None"]')!;
  expect(field.querySelectorAll("button")).toHaveLength(21);
  for (const { color } of BUILT_IN_COLOR_OPTIONS) {
    const button = field.querySelector<HTMLButtonElement>(
      `[data-value="${serializeStyleColor(color)}"]`,
    )!;
    button.click();
    expect(styleChange(...f.onChange.mock.lastCall!)).toEqual({
      property: "fill-color",
      value: color,
    });
  }
  clear.click();
  expect(styleChange(...f.onChange.mock.lastCall!)).toEqual({
    property: "fill-color",
    value: null,
  });
  expect(clear.getAttribute("aria-pressed")).toBe("true");
});
