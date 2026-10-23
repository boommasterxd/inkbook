// @vitest-environment happy-dom

import { Window as HappyWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountFeedbackActionMotion } from "../../../../src/obsidian/feedback/feedback-action-motion";
import { animateOwnedElement } from "../../../../src/obsidian/runtime/element-motion";

vi.mock("../../../../src/obsidian/runtime/element-motion", () => ({
  animateOwnedElement: vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() })),
}));

const KEYBOARD_CASES = [
  { popout: false, key: " " },
  { popout: false, key: "Enter" },
  { popout: true, key: " " },
  { popout: true, key: "Enter" },
];

const releases: Array<() => void> = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  vi.mocked(animateOwnedElement).mockClear();
  document.body.replaceChildren();
});

function fixture(ownerWindow: Window = window) {
  const root = ownerWindow.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  root.className = "inkbook-root";
  root.dataset.inkbookMotion = "reduced";
  const button = ownerWindow.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "button",
  ) as HTMLButtonElement;
  button.type = "button";
  root.append(button);
  ownerWindow.document.body.append(root);
  Object.defineProperty(button, "animate", { configurable: true, value: undefined });
  const motion = mountFeedbackActionMotion(button, ownerWindow);
  releases.push(motion.dispose);
  return { button, motion };
}

function keyboardFixture(popout: boolean) {
  const ownerWindow = popout ? (new HappyWindow() as unknown as Window) : window;
  const state = fixture(ownerWindow);
  state.button.focus();
  return { ownerWindow, ...state };
}

function pointer(target: EventTarget, type: string, pointerType: string): void {
  target.dispatchEvent(
    new PointerEvent(type, { pointerType, bubbles: true, isPrimary: true, button: 0 }),
  );
}

describe("feedback action motion", () => {
  it("ignores touch hover, restores mouse hover and press on leave and release", () => {
    const { button } = fixture();
    pointer(button, "pointerenter", "touch");
    expect(button.style.backgroundColor).toBe("transparent");
    pointer(button, "pointerenter", "mouse");
    expect(button.style.backgroundColor).toBe("var(--background-modifier-hover)");
    pointer(button, "pointerdown", "mouse");
    expect(button.style.backgroundColor).toBe("var(--interactive-hover)");
    pointer(window, "pointerup", "mouse");
    expect(button.style.backgroundColor).toBe("var(--background-modifier-hover)");
    pointer(button, "pointerleave", "mouse");
    expect(button.style.backgroundColor).toBe("transparent");
  });

  it("clears active interaction when disabled and releases owned styles on disposal", () => {
    const { button, motion } = fixture();
    pointer(button, "pointerenter", "mouse");
    button.disabled = true;
    motion.refresh();
    expect(button.style.backgroundColor).toBe("transparent");
    pointer(button, "pointerleave", "mouse");
    expect(button.style.backgroundColor).toBe("transparent");
    motion.dispose();
    expect(button.style.backgroundColor).toBe("");
  });

  it("releases a press in a pop-out window and clears hover after leaving", () => {
    const popup = new HappyWindow() as unknown as Window;
    const { button } = fixture(popup);
    pointer(button, "pointerenter", "mouse");
    pointer(button, "pointerdown", "mouse");
    expect(button.style.backgroundColor).toBe("var(--interactive-hover)");
    pointer(button, "pointerleave", "mouse");
    pointer(popup, "pointerup", "mouse");
    expect(button.style.backgroundColor).toBe("transparent");
  });

  it("keeps keyboard focus visible and releases pop-out keyboard press", () => {
    const popup = new HappyWindow() as unknown as Window;
    const { button } = fixture(popup);
    vi.spyOn(button, "matches").mockReturnValue(true);
    button.dispatchEvent(new FocusEvent("focus"));
    expect(button.style.backgroundColor).toBe("var(--background-modifier-hover)");
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(button.style.backgroundColor).toBe("var(--interactive-hover)");
    button.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
    expect(button.style.backgroundColor).toBe("var(--background-modifier-hover)");
    button.dispatchEvent(new FocusEvent("blur"));
    expect(button.style.backgroundColor).toBe("transparent");
  });

  it("retargets Motion color from the currently rendered color", () => {
    const { button } = fixture();
    const root = button.parentElement!;
    root.dataset.inkbookMotion = "full";
    Object.defineProperty(button, "animate", { configurable: true, value: vi.fn() });
    vi.spyOn(window, "getComputedStyle")
      .mockReturnValueOnce({
        backgroundColor: "rgb(10, 20, 30)",
        color: "rgb(20, 30, 40)",
      } as CSSStyleDeclaration)
      .mockReturnValueOnce({
        backgroundColor: "rgb(30, 40, 50)",
        color: "rgb(20, 30, 40)",
      } as CSSStyleDeclaration);
    pointer(button, "pointerenter", "mouse");
    pointer(button, "pointerdown", "mouse");
    const calls = vi.mocked(animateOwnedElement).mock.calls;
    expect(calls[calls.length - 1]?.[1]).toEqual(
      expect.objectContaining({
        backgroundColor: ["rgb(30, 40, 50)", "var(--interactive-hover)"],
      }),
    );
  });
});

it.each(KEYBOARD_CASES)(
  "supports $key press, blur and disabled feedback in pop-out $popout",
  ({ popout, key }) => {
    const { button, motion } = keyboardFixture(popout);
    button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    expect(button.style.backgroundColor).toBe("var(--interactive-hover)");
    button.blur();
    expect(button.style.backgroundColor).toBe("transparent");
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    button.disabled = true;
    motion.refresh();
    expect(button.style.backgroundColor).toBe("transparent");
    button.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    button.disabled = false;
    motion.refresh();
    expect(button.style.backgroundColor).toBe("transparent");
    motion.dispose();
  },
);

it.each(KEYBOARD_CASES)(
  "releases held $key when the owning window loses focus: pop-out $popout",
  ({ popout, key }) => {
    const { ownerWindow, button, motion } = keyboardFixture(popout);
    const resting = button.style.backgroundColor;
    button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    expect(button.style.backgroundColor).toBe("var(--interactive-hover)");
    ownerWindow.dispatchEvent(new Event("blur"));
    expect(ownerWindow.document.activeElement).toBe(button);
    expect(button.style.backgroundColor).toBe(resting);
    button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    expect(button.style.backgroundColor).toBe("var(--interactive-hover)");
    ownerWindow.dispatchEvent(new Event("pagehide"));
    expect(button.style.backgroundColor).toBe(resting);
    motion.dispose();
  },
);

it.each([false, true])(
  "cancels native Enter before button reuse after detached disposal %s",
  (detached) => {
    const { button, motion } = fixture();
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(button.style.backgroundColor).toBe("var(--interactive-hover)");
    const parent = button.parentElement!;
    if (detached) button.remove();
    motion.dispose();
    button.blur();
    parent.append(button);
    const replacement = mountFeedbackActionMotion(button, window);
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(button.style.backgroundColor).toBe("var(--interactive-hover)");
    button.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    expect(button.style.backgroundColor).toBe("var(--background-modifier-hover)");
    replacement.dispose();
  },
);
