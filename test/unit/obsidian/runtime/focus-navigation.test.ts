// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import { registerFocusNavigation } from "../../../../src/obsidian/runtime/focus-navigation";

import { createHtmlElement } from "../../../adapters/obsidian/dom";

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
});

function fixture(initial = false) {
  const root = createHtmlElement("div");
  const button = createHtmlElement("button");
  root.append(button);
  document.body.append(root);
  const dispose = registerFocusNavigation(root, initial);
  cleanups.push(dispose);
  return { root, button, dispose };
}

describe("explicit focus navigation", () => {
  it("keeps insertion and programmatic focus quiet until sequential navigation", () => {
    const { root, button } = fixture();
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(root.dataset.inkbookKeyboardNavigation).toBe("false");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }));
    expect(root.dataset.inkbookKeyboardNavigation).toBe("true");
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(root.dataset.inkbookKeyboardNavigation).toBe("true");
  });

  it.each(["mouse", "touch", "pen"])("clears navigation on %s contact", (pointerType) => {
    const { root, button } = fixture(true);
    button.dispatchEvent(new PointerEvent("pointerdown", { pointerType, bubbles: true }));
    button.focus();
    expect(root.dataset.inkbookKeyboardNavigation).toBe("false");
  });

  it.each(["touch", "pen"])(
    "clears %s navigation before the canvas boundary consumes window capture",
    (pointerType) => {
      const { root, button } = fixture(true);
      const consume = (event: Event): void => event.stopImmediatePropagation();
      window.addEventListener("pointerdown", consume, true);
      cleanups.push(() => window.removeEventListener("pointerdown", consume, true));
      button.dispatchEvent(new PointerEvent("pointerdown", { pointerType, bubbles: true }));
      expect(root.dataset.inkbookKeyboardNavigation).toBe("false");
    },
  );

  it.each([
    { key: "p" },
    { key: "z", ctrlKey: true },
    { key: "Tab", altKey: true },
    { key: "Enter", metaKey: true },
    { key: "Tab", isComposing: true },
  ])("retains keyboard focus through shortcuts and composition: %j", (keys) => {
    const { root, button } = fixture(true);
    button.dispatchEvent(new KeyboardEvent("keydown", { ...keys, bubbles: true }));
    expect(root.dataset.inkbookKeyboardNavigation).toBe("true");
  });

  it.each(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"])(
    "recognizes %s in controls but not on the canvas",
    (key) => {
      const { root, button } = fixture();
      button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      expect(root.dataset.inkbookKeyboardNavigation).toBe("false");
      root.setAttribute("role", "toolbar");
      button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      expect(root.dataset.inkbookKeyboardNavigation).toBe("true");
    },
  );

  it("keeps Shift and dismissal in the current modality and releases document listeners", () => {
    const { root, dispose } = fixture(true);
    for (const key of ["Shift", "Escape", " "]) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key }));
      expect(root.dataset.inkbookKeyboardNavigation).toBe("true");
    }
    dispose();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    document.dispatchEvent(new PointerEvent("pointerdown"));
    expect(root.dataset.inkbookKeyboardNavigation).toBeUndefined();
  });

  it("does not enable other presentations when navigating one toolbar", () => {
    const first = fixture();
    const second = fixture();
    first.root.setAttribute("role", "toolbar");
    first.button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(first.root.dataset.inkbookKeyboardNavigation).toBe("true");
    expect(second.root.dataset.inkbookKeyboardNavigation).toBe("false");
  });

  it("avoids redundant attribute mutations for repeated input", () => {
    const { root } = fixture();
    const observer = new MutationObserver(() => undefined);
    observer.observe(root, { attributes: true });
    for (let index = 0; index < 100; index += 1) {
      document.dispatchEvent(new PointerEvent("pointerdown"));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "p" }));
    }
    expect(observer.takeRecords()).toHaveLength(0);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(observer.takeRecords()).toHaveLength(1);
    observer.disconnect();
  });
});
