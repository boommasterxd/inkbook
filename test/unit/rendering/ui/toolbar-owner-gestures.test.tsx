// @vitest-environment happy-dom

import { Window as HappyWindow } from "happy-dom";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useToolbarOwnerGestures } from "../../../../src/rendering/ui/toolbar-owner-gestures";

const cleanups: Array<() => void> = [];
const reactEnvironment = window as Window & { IS_REACT_ACT_ENVIRONMENT?: boolean };

beforeEach(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
  vi.restoreAllMocks();
});

function GestureButton({ disabled = false }: { disabled?: boolean }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const state = useToolbarOwnerGestures(buttonRef, disabled);
  return (
    <>
      <button ref={buttonRef} type="button" disabled={disabled}>
        Tool
      </button>
      <output>{`${state.local}:${state.gesture}`}</output>
    </>
  );
}

function mountPopout(popup = new HappyWindow() as unknown as Window) {
  const container = popup.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  popup.document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<GestureButton />));
  const button = container.querySelector("button")!;
  const state = () => container.querySelector("output")?.textContent;
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { popup, button, state, root };
}

function pointer(target: EventTarget, type: string, pointerType: string, pointerId = 7): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerId,
        pointerType,
      }),
    );
  });
}

function key(
  target: EventTarget,
  type: "keydown" | "keyup",
  value = "Enter",
  repeat = false,
): boolean {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, key: value, repeat });
  act(() => {
    target.dispatchEvent(event);
  });
  return !event.defaultPrevented;
}

describe("toolbar pop-out owner gestures", () => {
  it("ignores touch hover and releases presses on the owning window", () => {
    const { popup, button, state } = mountPopout();
    expect(state()).toBe("true:rest");
    act(() => button.focus());
    expect(popup.document.activeElement).toBe(button);

    pointer(button, "pointerenter", "touch");
    expect(state()).toBe("true:rest");
    pointer(button, "pointerdown", "touch");
    expect(state()).toBe("true:press");
    pointer(window, "pointerup", "touch");
    expect(state()).toBe("true:press");
    pointer(popup, "pointerup", "touch");
    expect(state()).toBe("true:rest");

    pointer(button, "pointerdown", "touch");
    pointer(popup, "pointercancel", "touch");
    expect(state()).toBe("true:rest");
    expect(popup.document.activeElement).toBe(button);
  });

  it("clears mouse interaction on owner blur and releases owner listeners on unmount", () => {
    const popup = new HappyWindow() as unknown as Window;
    const addListener = vi.spyOn(popup, "addEventListener");
    const { button, state, root } = mountPopout(popup);
    const removeListener = vi.spyOn(popup, "removeEventListener");
    pointer(button, "pointerenter", "mouse");
    expect(state()).toBe("true:hover");
    pointer(button, "pointerdown", "mouse");
    expect(state()).toBe("true:press");
    act(() => {
      popup.dispatchEvent(new Event("blur"));
    });
    expect(state()).toBe("true:rest");

    act(() => root.unmount());
    for (const event of ["pointerup", "pointercancel", "blur"]) {
      const added = addListener.mock.calls.find(([name]) => name === event)?.[1];
      expect(added).toBeDefined();
      expect(removeListener.mock.calls).toContainEqual([event, added]);
    }
  });

  it.each(["Enter", " "])("releases %j press on keyup, blur and disable", (value) => {
    const { popup, button, state, root } = mountPopout();
    act(() => button.focus());
    expect(key(button, "keydown", value)).toBe(true);
    expect(state()).toBe("true:press");
    key(button, "keydown", value, true);
    expect(state()).toBe("true:press");
    expect(key(button, "keyup", value)).toBe(true);
    expect(state()).toBe("true:rest");

    key(button, "keydown", value);
    act(() => {
      button.dispatchEvent(new FocusEvent("blur"));
    });
    expect(state()).toBe("true:rest");

    key(button, "keydown", value);
    act(() => {
      popup.dispatchEvent(new Event("blur"));
    });
    expect(state()).toBe("true:rest");

    key(button, "keydown", value);
    const removeListener = vi.spyOn(button, "removeEventListener");
    act(() => root.render(<GestureButton disabled />));
    expect(button.disabled).toBe(true);
    expect(state()).toBe("true:rest");
    for (const event of ["keydown", "keyup", "blur"]) {
      expect(removeListener.mock.calls.some(([name]) => name === event)).toBe(true);
    }
    key(button, "keydown", value);
    expect(state()).toBe("true:rest");
  });
});

describe("toolbar main-window owner gestures", () => {
  it("keeps main-window Space presses across rerenders and releases them on pagehide or disable", () => {
    const { button, state, root } = mountPopout(window);
    act(() => button.focus());
    expect(key(button, "keydown", " ")).toBe(true);
    expect(state()).toBe("false:press");
    act(() => root.render(<GestureButton />));
    expect(state()).toBe("false:press");
    expect(key(button, "keyup", " ")).toBe(true);
    expect(state()).toBe("false:rest");

    key(button, "keydown", " ");
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(state()).toBe("false:rest");
    key(button, "keydown", " ");
    act(() => root.render(<GestureButton disabled />));
    expect(button.disabled).toBe(true);
    expect(state()).toBe("false:rest");
    key(button, "keydown", " ");
    expect(state()).toBe("false:rest");
    act(() => root.render(<GestureButton />));
    key(button, "keydown", " ");
    expect(state()).toBe("false:press");
    key(button, "keyup", " ");
    expect(state()).toBe("false:rest");
  });
});
