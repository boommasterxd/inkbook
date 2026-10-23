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

function key(target: EventTarget, type: "keydown" | "keyup", repeat = false): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: "Enter", repeat }));
  });
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

  it("releases Enter press on keyup, blur and disable", () => {
    const { popup, button, state, root } = mountPopout();
    act(() => button.focus());
    key(button, "keydown");
    expect(state()).toBe("true:press");
    key(button, "keydown", true);
    expect(state()).toBe("true:press");
    key(button, "keyup");
    expect(state()).toBe("true:rest");

    key(button, "keydown");
    act(() => {
      button.dispatchEvent(new FocusEvent("blur"));
    });
    expect(state()).toBe("true:rest");

    key(button, "keydown");
    act(() => {
      popup.dispatchEvent(new Event("blur"));
    });
    expect(state()).toBe("true:rest");

    key(button, "keydown");
    const removeListener = vi.spyOn(button, "removeEventListener");
    act(() => root.render(<GestureButton disabled />));
    expect(button.disabled).toBe(true);
    expect(state()).toBe("true:rest");
    for (const event of ["keydown", "keyup", "blur"]) {
      expect(removeListener.mock.calls.some(([name]) => name === event)).toBe(true);
    }
    key(button, "keydown");
    expect(state()).toBe("true:rest");
  });
});
