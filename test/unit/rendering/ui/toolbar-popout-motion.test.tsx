// @vitest-environment happy-dom

import { Window as HappyWindow } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InkbookEditorChrome } from "../../../../src/rendering/ui/editor-chrome";
import { createEditorChromeProps } from "../../../fixtures/editor-chrome";

const reactEnvironment = window as Window & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const cleanups: Array<() => void> = [];

beforeEach(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
  vi.restoreAllMocks();
});

function pointer(target: EventTarget, type: string, pointerType: string): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerId: 7,
        pointerType,
      }),
    );
  });
}

describe("Motion toolbar in a pop-out window", () => {
  it("keeps pointer completion in its owner window across repeated presses and keyboard use", () => {
    const popup = new HappyWindow() as unknown as Window;
    const mainAdd = vi.spyOn(window, "addEventListener");
    const ownerAdd = vi.spyOn(popup, "addEventListener");
    const presentation = popup.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    presentation.className = "inkbook-root";
    presentation.dataset.inkbookMotion = "reduced";
    const container = popup.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    presentation.append(container);
    popup.document.body.append(presentation);
    const root = createRoot(container);
    cleanups.push(() => {
      act(() => root.unmount());
      presentation.remove();
    });
    const onToolbarAction = vi.fn();
    const props = createEditorChromeProps(popup.document);
    act(() => root.render(<InkbookEditorChrome {...props} onToolbarAction={onToolbarAction} />));
    const draw = container.querySelector<HTMLButtonElement>("[data-inkbook-action='draw']");
    expect(draw).not.toBeNull();
    if (draw === null) return;

    act(() => draw.focus());
    expect(popup.document.activeElement).toBe(draw);
    pointer(draw, "pointerenter", "touch");
    for (const end of ["pointerup", "pointercancel"] as const) {
      pointer(draw, "pointerdown", "touch");
      pointer(popup, end, "touch");
    }
    pointer(draw, "pointerenter", "mouse");
    pointer(draw, "pointerdown", "mouse");
    pointer(popup, "pointerup", "mouse");

    for (const type of ["keydown", "keyup"] as const) {
      act(() => {
        draw.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: "Enter" }));
      });
    }
    act(() => draw.click());
    expect(onToolbarAction).toHaveBeenCalledWith("draw", draw);
    expect(popup.document.activeElement).toBe(draw);
    expect(draw.disabled).toBe(false);

    for (const event of ["pointerup", "pointercancel"]) {
      expect(ownerAdd.mock.calls.some(([name]) => name === event)).toBe(true);
      expect(mainAdd.mock.calls.some(([name]) => name === event)).toBe(false);
    }
  });
});
