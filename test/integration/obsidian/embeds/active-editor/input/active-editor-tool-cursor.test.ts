import { describe, expect, it } from "vitest";
import { activeEditorPointerHarness as harness } from "../../../../../fixtures/obsidian/active-editor-pointer";
import { cursorPointerEvent } from "../../../../../fixtures/obsidian/tool-cursor";

describe("active editor pointer and cursor composition", () => {
  it("routes idle hover to the scene reader without synchronous navigation, gesture, or UI dispatch", () => {
    const h = harness();
    for (let x = 100; x < 200; x += 1) {
      h.pointer.handlePointerMove(cursorPointerEvent({ clientX: x }));
    }
    expect(h.measure).not.toHaveBeenCalled();
    expect(h.screenPointer).not.toHaveBeenCalled();
    expect(h.coalesced).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.read().cursor).toMatchObject({ x: 199, y: 80, kind: "tool" });
    expect(h.measure).toHaveBeenCalledOnce();
    h.controller.dispose();
  });

  it("preserves gesture input and the tool icon through drawing and commit", () => {
    const h = harness();
    h.pointer.handlePointerMove(cursorPointerEvent());
    expect(h.read().cursor?.kind).toBe("tool");
    h.pointer.handlePointerDown(cursorPointerEvent({ button: 0, buttons: 1, pressure: 0.5 }));
    expect(h.read()).toMatchObject({
      cursor: { kind: "tool", icon: h.toolIcon, x: 120, y: 80 },
      system: "crosshair",
    });
    h.pointer.handlePointerMove(cursorPointerEvent({ clientX: 150, buttons: 1, pressure: 0.5 }));
    expect(h.coalesced).toHaveBeenCalledOnce();
    expect(h.read().cursor).toMatchObject({ kind: "tool", icon: h.toolIcon, x: 150 });
    h.pointer.handlePointerUp(cursorPointerEvent({ clientX: 150 }));
    expect(h.controls.input.interaction).toBeUndefined();
    expect(h.read().cursor).toMatchObject({ kind: "tool", icon: h.toolIcon, x: 150 });
    h.pointer.handlePointerMove(cursorPointerEvent({ clientX: 150 }));
    expect(h.read().cursor).toMatchObject({ kind: "tool", icon: h.toolIcon, x: 150 });
    h.pointer.handlePointerMove(cursorPointerEvent({ clientX: 151 }));
    expect(h.read().cursor?.kind).toBe("tool");
    h.pointer.handlePointerCancel(cursorPointerEvent());
    expect(h.read()).toEqual({ cursor: null, system: "default" });
    h.controller.dispose();
  });

  it("clears feedback after unexpected capture loss and waits for fresh hover", () => {
    const h = harness();
    h.pointer.handlePointerDown(cursorPointerEvent({ button: 0, buttons: 1, pressure: 0.5 }));
    expect(h.controls.input.interaction?.phase).toBe("tool-gesture");
    h.pointer.handleLostPointerCapture(cursorPointerEvent());
    expect(h.controls.input.interaction).toBeUndefined();
    expect(h.read()).toEqual({ cursor: null, system: "default" });
    h.controller.refresh();
    expect(h.read()).toEqual({ cursor: null, system: "default" });
    h.pointer.handlePointerMove(cursorPointerEvent());
    expect(h.read().cursor?.kind).toBe("tool");
    h.controller.dispose();
  });
});
