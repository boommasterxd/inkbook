// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Localization } from "../../../../src/domain/localization";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { styleChange } from "../../../../src/obsidian/embeds/active-editor/controller-style-values";
import type { StyleControl } from "../../../../src/obsidian/menus/editor-menu-types";
import { createStyleMenuContent } from "../../../../src/obsidian/menus/style-menu-content";
import { createToolStyleControls } from "../../../../src/obsidian/menus/tool-style-controls";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

const cleanups: (() => void)[] = [];
beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  vi.useRealTimers();
});

function fixture() {
  const localization = new Localization();
  const controls = createToolStyleControls(createBuiltInSettings().toolDefaults, "draw");
  const onChange = vi.fn<(controlId: string, value: boolean | number | string) => void>();
  let sync: (controls: readonly StyleControl[]) => void = () => undefined;
  const fragment = createStyleMenuContent({
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
  document.body.append(fragment);
  const field = document.querySelector<HTMLElement>('[data-control="color"]')!;
  const grid = field.querySelector<HTMLElement>(".inkbook-menu-color-grid")!;
  const trigger = grid.querySelector<HTMLButtonElement>('[data-value="theme-text"]')!;
  const panel = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const choose = (value: string) =>
    panel.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!.click();
  return {
    localization,
    onChange,
    field,
    grid,
    trigger,
    panel,
    choose,
    sync: (value: string | null) =>
      sync(
        controls.map((control) =>
          control.id === "color" && control.kind === "choice"
            ? { ...control, value, mixed: value === null }
            : control,
        ),
      ),
  };
}

it("keeps one neutral palette slot and commits explicit or automatic colors through the real parser", () => {
  const f = fixture();
  expect(f.grid.querySelectorAll("button")).toHaveLength(10);
  expect(f.trigger.textContent).toBe("Auto");
  expect(
    document.getElementById(f.trigger.getAttribute("aria-describedby")!)?.textContent,
  ).toContain("PDF");
  for (const [value, color] of [
    ["#000000FF", { type: "rgba", value: "#000000FF" }],
    ["#FFFFFFFF", { type: "rgba", value: "#FFFFFFFF" }],
    ["theme-text", { type: "theme-text" }],
  ] as const) {
    const committed = f.onChange.mock.calls.length;
    f.trigger.click();
    expect(f.panel.hidden).toBe(false);
    expect(f.onChange).toHaveBeenCalledTimes(committed);
    f.choose(value);
    expect(styleChange(...f.onChange.mock.lastCall!)).toEqual({ property: "color", value: color });
    expect(f.panel.hidden).toBe(true);
    expect(f.trigger.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(f.trigger);
  }
  f.grid.querySelector<HTMLButtonElement>('[data-value="#EF4444FF"]')!.click();
  expect(f.onChange).toHaveBeenLastCalledWith("color", "#EF4444FF");
  expect(f.trigger.getAttribute("aria-pressed")).toBe("false");
});

it("synchronizes mixed and fixed neutral selections and translates an open chooser", () => {
  const f = fixture();
  f.sync("#000000FF");
  expect(f.trigger.getAttribute("aria-label")).toBe("Black: Auto, black or white");
  expect(
    document.getElementById(f.trigger.getAttribute("aria-describedby")!)?.textContent,
  ).toContain("Black");
  f.trigger.click();
  f.sync("#FFFFFFFF");
  expect(f.panel.hidden).toBe(false);
  expect(f.trigger.getAttribute("aria-label")).toBe("White: Auto, black or white");
  expect(f.panel.querySelector('[data-value="#FFFFFFFF"]')?.getAttribute("aria-pressed")).toBe(
    "true",
  );
  f.localization.setLanguage("de");
  expect(f.trigger.getAttribute("aria-label")).toBe("Weiß: Auto, Schwarz oder Weiß");
  expect(
    document.getElementById(f.trigger.getAttribute("aria-describedby")!)?.textContent,
  ).toContain("Weiß");
  expect(f.panel.textContent).toContain("Schwarz");
  f.panel.querySelector<HTMLButtonElement>("button")!.focus();
  f.sync(null);
  expect(f.panel.hidden).toBe(true);
  expect(f.field.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
  expect(f.trigger.textContent).toBe("Auto");
  expect(document.activeElement).toBe(f.trigger);
  expect(f.onChange).not.toHaveBeenCalled();
});

it("opens with the keyboard and consumes Escape before the owning menu", () => {
  const f = fixture();
  f.trigger.focus();
  const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  f.trigger.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true);
  expect(f.panel.contains(document.activeElement)).toBe(true);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(f.panel.hidden).toBe(true);
  expect(document.activeElement).toBe(f.trigger);
  f.trigger.click();
  cleanups.splice(0).forEach((cleanup) => cleanup());
  const afterDispose = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  f.trigger.dispatchEvent(afterDispose);
  expect(afterDispose.defaultPrevented).toBe(false);
});
