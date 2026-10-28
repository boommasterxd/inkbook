// @vitest-environment happy-dom
import "../../../../fixtures/obsidian/menu-motion";

import { Window as HappyWindow } from "happy-dom";
import { Platform } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { registerMenuFeedback } from "../../../../../src/obsidian/menus/feedback/menu-feedback";
import type { StyleControl } from "../../../../../src/obsidian/menus/editor-menu-types";
import { createStyleMenuContent } from "../../../../../src/obsidian/menus/style-menu-content";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";

const feedbackStyles = Platform.isDesktop
  ? (await import("node:fs")).readFileSync("src/obsidian/styles/menu-feedback.css", "utf8")
  : "";

beforeEach(() => {
  vi.useFakeTimers();
  const stylesheet = new CSSStyleSheet();
  stylesheet.replaceSync(feedbackStyles);
  document.adoptedStyleSheets = [stylesheet];
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.adoptedStyleSheets = [];
});

it("keeps pop-out hover, keyboard focus, and press lifecycle in the owning window", () => {
  const ownerWindow = new HappyWindow() as unknown as Window;
  const { root, item, release } = menuButtonFixture(ownerWindow, "full");
  const Pointer = (ownerWindow as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
  const mainListeners = vi.spyOn(window, "addEventListener");
  const ownerListeners = vi.spyOn(ownerWindow, "addEventListener");
  const ownerRemovals = vi.spyOn(ownerWindow, "removeEventListener");

  item.disabled = true;
  item.dispatchEvent(new Pointer("pointerover", { bubbles: true, pointerType: "mouse" }));
  expect(item.style.backgroundColor).toBe("");
  item.disabled = false;
  item.dispatchEvent(new Pointer("pointerover", { bubbles: true, pointerType: "mouse" }));
  vi.advanceTimersByTime(120);
  expect(item.style.backgroundColor).toBe("");
  root.dispatchEvent(new Pointer("pointerleave", { pointerType: "mouse" }));
  vi.advanceTimersByTime(120);
  expect(item.style.backgroundColor).toBe("");

  const Key = (ownerWindow as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  ownerWindow.document.dispatchEvent(new Key("keydown", { key: "Tab", bubbles: true }));
  item.focus();
  vi.advanceTimersByTime(120);
  expect(item.style.backgroundColor).toBe("");
  item.dispatchEvent(new Pointer("pointerover", { bubbles: true, pointerType: "touch" }));
  expect(item.style.backgroundColor).toBe("");
  item.dispatchEvent(
    new Pointer("pointerdown", {
      bubbles: true,
      pointerId: 7,
      pointerType: "touch",
      isPrimary: true,
    }),
  );
  expect(ownerListeners.mock.calls.some(([name]) => name === "pointerup")).toBe(true);
  expect(mainListeners.mock.calls.some(([name]) => name === "pointerup")).toBe(false);
  ownerWindow.dispatchEvent(new Pointer("pointerup", { pointerId: 7, pointerType: "touch" }));
  expect(ownerRemovals.mock.calls.some(([name]) => name === "pointerup")).toBe(true);
  vi.advanceTimersByTime(120);
  expect(item.style.backgroundColor).toBe("");
  release();
  expect(vi.getTimerCount()).toBe(0);
  ownerWindow.close();
});

it("releases interrupted pop-out pointer ownership before accepting another pointer", () => {
  const ownerWindow = new HappyWindow() as unknown as Window;
  const { item, release } = menuButtonFixture(ownerWindow, "reduced");
  const Pointer = (ownerWindow as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
  const ownerListeners = vi.spyOn(ownerWindow, "addEventListener");
  const ownerRemovals = vi.spyOn(ownerWindow, "removeEventListener");
  const activate = vi.fn();
  item.addEventListener("click", activate);
  for (const [index, interruption] of ["blur", "pagehide"].entries()) {
    item.dispatchEvent(
      new Pointer("pointerdown", {
        bubbles: true,
        pointerId: 7 + index,
        pointerType: "touch",
        isPrimary: true,
      }),
    );
    expect(ownerListeners.mock.calls.filter(([name]) => name === "pointerup")).toHaveLength(
      index + 1,
    );
    ownerWindow.dispatchEvent(new Event(interruption));
    expect(ownerRemovals.mock.calls.filter(([name]) => name === "pointerup")).toHaveLength(
      index + 1,
    );
    expect(ownerRemovals).toHaveBeenCalledWith("blur", expect.any(Function));
    expect(ownerRemovals).toHaveBeenCalledWith("pagehide", expect.any(Function));
  }
  expect(activate).not.toHaveBeenCalled();
  release();
  expect(vi.getTimerCount()).toBe(0);
  ownerWindow.close();
});

it("commits choice semantics immediately while retargeting owned paint and releases pending work", async () => {
  const root = menuRoot();
  const onChange = appendMenuControls(root, [OUTLINE_STYLE]);
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")];
  const [solid, dashed] = buttons;
  const release = registerMenuFeedback(root, root, window);
  dashed!.focus();
  for (const button of [dashed!, solid!, dashed!]) {
    button.click();
    expect(buttons.map((item) => item.getAttribute("aria-pressed"))).toEqual(
      buttons.map((item) => String(item === button)),
    );
    expect(onChange).toHaveBeenLastCalledWith("outline-style", button.dataset.value);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(document.activeElement).toBe(dashed);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  release();
  expect(vi.getTimerCount()).toBe(0);
  expect(buttons.every((button) => button.style.backgroundColor === "")).toBe(true);
  solid!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("retains switch semantics through reversal and reduced motion, then releases ownership", async () => {
  const root = menuRoot();
  const onChange = appendMenuControls(root, [
    { id: "pressure-enabled", kind: "toggle", label: "Pressure sensitivity", checked: false },
  ]);
  const input = root.querySelector<HTMLInputElement>("input")!;
  const release = registerMenuFeedback(root, root, window);
  for (const checked of [true, false, true]) {
    input.click();
    expect(input.checked).toBe(checked);
    expect(onChange).toHaveBeenLastCalledWith("pressure-enabled", checked);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  }
  root.dataset.inkbookMotion = "reduced";
  await vi.advanceTimersByTimeAsync(0);
  expect(input.checked).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  release();
  input.click();
  expect(input.checked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not bind nested settings choices twice or add a wrapper tab stop", async () => {
  const outer = menuRoot();
  const nested = outer.createDiv();
  appendMenuControls(nested, [OUTLINE_STYLE]);
  const releaseNested = registerMenuFeedback(nested, outer, window);
  const releaseOuter = registerMenuFeedback(outer, outer, window);
  expect(nested.hasAttribute("tabindex")).toBe(false);
  const dashed = nested.querySelector<HTMLButtonElement>("button[data-value='dashed']")!;
  dashed.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(dashed.getAttribute("aria-pressed")).toBe("true");
  releaseNested();
  expect(vi.getTimerCount()).toBe(0);
  releaseOuter();
});

it.each(["full", "reduced"])(
  "returns choice paint to the theme cascade after interrupted %s motion",
  async (motion) => {
    const root = menuRoot();
    root.dataset.inkbookMotion = motion;
    appendMenuControls(root, [OUTLINE_STYLE]);
    const theme = new CSSStyleSheet();
    const rule = ".inkbook-root .inkbook-menu-choice[aria-pressed='true']";
    theme.replaceSync(`${rule} { color: rgb(10, 20, 30); }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, theme];
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")];
    const release = registerMenuFeedback(root, root, window);
    for (const button of [buttons[1]!, buttons[0]!, buttons[1]!]) {
      button.click();
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(120);
    const selected = buttons[1]!;
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(window.getComputedStyle(selected).color).toBe("rgb(10, 20, 30)");
    theme.replaceSync(`${rule} { color: rgb(40, 50, 60); }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets];
    expect(window.getComputedStyle(selected).color).toBe("rgb(40, 50, 60)");
    expect(selected.style.color).toBe("");
    release();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("keeps settled choice and recorder paint at their previous state when semantics change", async () => {
  const root = menuRoot();
  appendMenuControls(root, [OUTLINE_STYLE]);
  const recorder = root.createEl("button", { cls: "inkbook-shortcut-recorder" });
  const theme = new CSSStyleSheet();
  theme.replaceSync(`
    .inkbook-menu-choice, .inkbook-shortcut-recorder { border-color: rgb(10, 20, 30); }
    .inkbook-menu-choice[data-inkbook-choice-state="selected"],
    .inkbook-shortcut-recorder[data-inkbook-recording-state="true"] {
      border-color: rgb(40, 50, 60);
    }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, theme];
  const choice = root.querySelector<HTMLButtonElement>("button[data-value='dashed']")!;
  const release = registerMenuFeedback(root, root, window);
  for (const [item, attribute] of [
    [choice, "aria-pressed"],
    [recorder, "data-recording"],
  ] as const) {
    const before = window.getComputedStyle(item).borderColor;
    item.setAttribute(attribute, "true");
    expect(item.getAttribute(attribute)).toBe("true");
    await vi.advanceTimersByTimeAsync(0);
    expect(window.getComputedStyle(item).borderColor).toBe(before);
    await vi.advanceTimersByTimeAsync(120);
    expect(window.getComputedStyle(item).borderColor).not.toBe(before);
    expect(item.style.borderColor).toBe("");
  }
  release();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["full", "reduced"])(
  "preserves readable destructive action contrast through first hover and canceled press with %s motion",
  async (preference) => {
    installObsidianDomHelpers();
    const root = document.body.createDiv({ cls: "inkbook-root inkbook-dialog-actions" });
    root.dataset.inkbookMotion = preference;
    const theme = new CSSStyleSheet();
    theme.replaceSync(
      ".inkbook-dialog-actions .mod-warning { background-color: rgb(181.74, 38.22, 55.38); color: white; }",
    );
    document.adoptedStyleSheets = [theme, ...document.adoptedStyleSheets];
    const button = root.createEl("button", { cls: "mod-warning", text: "Delete embed" });
    const activate = vi.fn();
    button.addEventListener("click", activate);
    for (const [token, value] of Object.entries({
      "--background-modifier-error": "rgb(233, 49, 71)",
      "--background-modifier-error-hover": "rgb(233, 49, 71)",
      "--inkbook-dialog-danger-background": "rgb(181.74, 38.22, 55.38)",
      "--inkbook-dialog-danger-hover": "rgb(158.44, 33.32, 48.28)",
      "--inkbook-dialog-danger-pressed": "rgb(135.14, 28.42, 41.18)",
      "--interactive-normal": "rgb(255, 255, 255)",
      "--interactive-hover": "rgb(250, 250, 250)",
    }))
      button.style.setProperty(token, value);
    const release = registerMenuFeedback(root, root, window);
    root.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    button.dispatchEvent(new PointerEvent("pointerover", { pointerType: "mouse", bubbles: true }));
    expect(actionContrast(button)).toBeGreaterThanOrEqual(4.5);
    await vi.advanceTimersByTimeAsync(120);
    const hoverContrast = actionContrast(button);
    expect(hoverContrast).toBeGreaterThanOrEqual(4.5);
    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerType: "touch",
        pointerId: 3,
        isPrimary: true,
        bubbles: true,
      }),
    );
    expect(actionContrast(button)).toBeGreaterThanOrEqual(4.5);
    await vi.advanceTimersByTimeAsync(120);
    expect(actionContrast(button)).toBeGreaterThan(hoverContrast);
    window.dispatchEvent(
      new PointerEvent("pointercancel", {
        pointerType: "touch",
        pointerId: 3,
        isPrimary: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(120);
    expect(actionContrast(button)).toBeGreaterThanOrEqual(4.5);
    expect(activate).not.toHaveBeenCalled();
    release();
    expect(vi.getTimerCount()).toBe(0);
  },
);

function actionContrast(element: HTMLElement): number {
  const style = window.getComputedStyle(element);
  const luminance = (paint: string): number => {
    const token = /^var\(([^)]+)\)$/.exec(paint)?.[1];
    const resolved = token === undefined ? paint : style.getPropertyValue(token);
    const channels =
      resolved === "white" ? [255, 255, 255] : resolved.match(/[\d.]+/g)?.map(Number);
    if (channels === undefined || channels.length !== 3)
      throw new Error(`Invalid color: ${resolved}`);
    return channels.reduce((sum, value, index) => {
      const normalized = value / 255;
      const linear =
        normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
    }, 0);
  };
  const foreground = luminance(style.color);
  const background = luminance(style.backgroundColor);
  return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
}

it.each([
  { popout: false, key: " " },
  { popout: false, key: "Enter" },
  { popout: true, key: " " },
  { popout: true, key: "Enter" },
])(
  "releases $key press and blur in the owning menu window: pop-out $popout",
  async ({ popout, key }) => {
    const ownerWindow = popout ? (new HappyWindow() as unknown as Window) : window;
    const { root, item, release } = menuButtonFixture(ownerWindow, "reduced");
    item.focus();
    item.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    expect(item.style.backgroundColor).toBe("");
    item.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    expect(item.style.backgroundColor).toBe("");
    item.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    item.blur();
    expect(item.style.backgroundColor).toBe("");
    item.focus();
    item.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    item.disabled = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(item.style.backgroundColor).toBe("");
    item.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    item.disabled = false;
    item.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    expect(item.style.backgroundColor).toBe("");
    ownerWindow.dispatchEvent(new Event("blur"));
    expect(ownerWindow.document.activeElement).toBe(item);
    expect(item.style.backgroundColor).toBe("");
    item.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    expect(item.style.backgroundColor).toBe("");
    ownerWindow.dispatchEvent(new Event("pagehide"));
    expect(item.style.backgroundColor).toBe("");
    release();
    root.remove();
  },
);

const OUTLINE_STYLE: StyleControl = {
  id: "outline-style",
  kind: "choice",
  label: "Outline style",
  value: "solid",
  options: [
    { label: "Solid", value: "solid" },
    { label: "Dashed", value: "dashed" },
  ],
};

function menuRoot(): HTMLElement {
  installObsidianDomHelpers();
  const root = document.body.createDiv({ cls: "inkbook-root" });
  root.dataset.inkbookMotion = "full";
  return root;
}

function appendMenuControls(root: HTMLElement, controls: readonly StyleControl[]) {
  const onChange = vi.fn();
  root.append(
    createStyleMenuContent({
      controls,
      onChange,
      ownerDocument: root.ownerDocument,
      renderIcon: () => undefined,
    }),
  );
  return onChange;
}

function menuButtonFixture(ownerWindow: Window, preference: "full" | "reduced") {
  const Stylesheet = (ownerWindow as Window & { CSSStyleSheet: typeof CSSStyleSheet })
    .CSSStyleSheet;
  const stylesheet = new Stylesheet();
  stylesheet.replaceSync(feedbackStyles);
  ownerWindow.document.adoptedStyleSheets = [stylesheet];
  const root = ownerWindow.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  root.className = "inkbook-root";
  root.dataset.inkbookMotion = preference;
  const item = ownerWindow.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "button",
  ) as HTMLButtonElement;
  item.className = "inkbook-owned-menu-item";
  item.tabIndex = 0;
  root.append(item);
  ownerWindow.document.body.append(root);
  const release = registerMenuFeedback(root, root, ownerWindow);
  return { root, item, release };
}
