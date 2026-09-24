import { describe, expect, it } from "vitest";
import { activeEditorPointerHarness as harness } from "../../../fixtures/obsidian/active-editor-pointer";
import {
  cursorPointerEvent,
  timedCursorPointerEvent,
} from "../../../fixtures/obsidian/tool-cursor";

function pen(overrides: Partial<PointerEvent> = {}): PointerEvent {
  return cursorPointerEvent({ pointerType: "pen", ...overrides });
}

describe("active editor pen button routing", () => {
  it.each([2, 4])(
    "starts barrel mask %i from hovering without requiring another pointerdown",
    (buttons) => {
      const h = harness();
      h.pointer.handlePointerDown(pen({ button: buttons === 2 ? 2 : 1, buttons }));
      h.pointer.handlePointerMove(pen({ buttons }));
      expect(h.effects).toEqual([]);
      expect(h.capture).not.toHaveBeenCalled();
      expect(h.beginGestureGeometry).not.toHaveBeenCalled();
      expect(h.hit).not.toHaveBeenCalled();
      expect(h.read().cursor?.kind).toBe("eraser");
      h.pointer.handlePointerMove(pen({ buttons: buttons | 1, pressure: 0.5 }));
      expect(h.controls.input.interaction?.phase).toBe("eraser-gesture");
      expect(h.capture).toHaveBeenCalledExactlyOnceWith(1);
      expect(h.beginGestureGeometry).toHaveBeenCalledOnce();
      expect(h.hit).toHaveBeenCalledOnce();
      expect(h.effects).toContainEqual(
        expect.objectContaining({ type: "begin-preview", tool: "eraser" }),
      );
      h.pointer.handlePointerUp(pen({ buttons, clientX: 900 }));
      expect(
        h.effects
          .filter((effect) => effect.type === "update-preview")
          .map((effect) => effect.pointer.x),
      ).not.toContain(880);
      expect(h.controls.input.interaction).toBeUndefined();
      expect(h.controls.input.activeTool).toBe("draw");
      h.controller.dispose();
    },
  );

  it("accepts eraser-tip contact with the ordinary contact bit still set", () => {
    const h = harness();
    h.pointer.handlePointerDown(pen({ button: 5, buttons: 33, pressure: 0.5 }));
    expect(h.controls.input.interaction?.phase).toBe("eraser-gesture");
    expect(h.capture).toHaveBeenCalledExactlyOnceWith(1);
    h.controller.dispose();
  });

  it.each([false, true])(
    "suppresses drawing until lift after barrel release with capture loss %s",
    (loseCapture) => {
      const h = harness();
      h.pointer.handlePointerDown(pen({ button: 0, buttons: 1, pressure: 0.5 }));
      h.pointer.handlePointerMove(pen({ button: 2, buttons: 3, pressure: 0.5 }));
      expect(h.effects).toContainEqual({ type: "revert-preview", kind: "tool-gesture" });
      expect(h.controls.input.interaction?.phase).toBe("eraser-gesture");
      expect(h.capture).toHaveBeenCalledOnce();
      expect(h.release).not.toHaveBeenCalled();
      h.pointer.handlePointerMove(pen({ button: 2, buttons: 1, pressure: 0.5 }));
      expect(h.effects).toContainEqual({ type: "commit-preview", kind: "eraser-gesture" });
      expect(h.controls.input.interaction).toBeUndefined();
      expect(h.controls.input.activeTool).toBe("draw");
      expect(h.controls.input.consumedPointerIds).toContain(1);
      expect(h.release).not.toHaveBeenCalled();
      if (loseCapture) h.pointer.handleLostPointerCapture(pen());
      const completed = h.effects.length;
      h.pointer.handlePointerMove(pen({ buttons: 1, pressure: 0.5 }));
      expect(h.effects).toHaveLength(completed);
      h.pointer.handlePointerMove(pen());
      expect(h.controls.input.consumedPointerIds).not.toContain(1);
      expect(h.release).toHaveBeenCalledWith(1);
      h.pointer.handlePointerDown(pen({ button: 0, buttons: 1, pressure: 0.5 }));
      expect(h.controls.input.interaction?.phase).toBe("tool-gesture");
      h.controller.dispose();
    },
  );

  it("ignores foreign mouse and touch movement during barrel erasing", () => {
    const h = harness();
    h.pointer.handlePointerDown(pen({ button: 2, buttons: 3, pressure: 0.5 }));
    const interaction = h.controls.input.interaction;
    const count = h.effects.length;
    for (const pointerType of ["mouse", "touch"]) {
      h.pointer.handlePointerMove(pen({ pointerType, pointerId: 2, buttons: 1, pressure: 0.5 }));
    }
    expect(h.controls.input.interaction).toEqual(interaction);
    expect(h.effects).toHaveLength(count);
    h.controller.dispose();
  });

  it("consumes pen context menus without interrupting the active eraser", () => {
    const h = harness();
    h.pointer.handlePointerDown(pen({ button: 2, buttons: 3, pressure: 0.5 }));
    const event = Object.assign(new Event("contextmenu", { cancelable: true }), {
      pointerType: "pen",
    });
    h.pointer.handleContextMenu(event as unknown as MouseEvent);
    expect(event.defaultPrevented).toBe(true);
    expect(h.controls.input.interaction?.phase).toBe("eraser-gesture");
    h.controller.dispose();
  });
});

describe("active editor pen role continuity", () => {
  it("retains Wacom hover erasing through a synthetic release and the following contact", () => {
    const h = harness();
    const event = (time: number, fields: Partial<PointerEvent>) =>
      timedCursorPointerEvent(time, { pointerType: "pen", ...fields });
    h.pointer.handlePointerDown(event(10, { button: 1, buttons: 4 }));
    h.pointer.handlePointerUp(event(20, { button: 1, buttons: 0 }));
    h.pointer.handlePointerDown(event(100, { button: 0, buttons: 1, pressure: 0.5 }));
    expect(h.controls.input.interaction?.phase).toBe("eraser-gesture");
    h.pointer.handlePointerMove(event(500, { buttons: 1, pressure: 0.5, clientX: 150 }));
    expect(h.controls.input.interaction?.phase).toBe("eraser-gesture");
    expect(h.effects).toContainEqual(
      expect.objectContaining({ type: "update-preview", kind: "eraser-gesture" }),
    );
    h.pointer.handlePointerUp(event(510, { buttons: 0 }));
    expect(h.controls.input.interaction).toBeUndefined();
    h.flushTimers();
    expect(h.read().cursor?.kind).toBe("tool");
    h.pointer.handlePointerDown(event(820, { button: 0, buttons: 1, pressure: 0.5 }));
    expect(h.controls.input.interaction?.phase).toBe("tool-gesture");
    h.controller.dispose();
  });

  it.each(["manual", "control", "barrel"] as const)(
    "continues eraser movement after repeated role changes with %s erasing",
    (mode) => {
      const h = harness();
      if (mode === "manual") h.controls.input = { ...h.controls.input, activeTool: "eraser" };
      h.pointer.handlePointerDown(
        pen({
          button: 0,
          buttons: mode === "barrel" ? 3 : 1,
          pressure: 0.5,
          ctrlKey: mode === "control",
        }),
      );
      for (const clientX of [150, 160]) {
        h.pointer.handlePointerMove(
          pen({
            clientX,
            buttons: mode === "barrel" ? 33 : 3,
            pressure: 0.5,
            ctrlKey: mode === "control",
          }),
        );
      }
      expect(h.controls.input.interaction?.phase).toBe("eraser-gesture");
      expect(
        h.effects
          .filter((effect) => effect.type === "update-preview")
          .map((effect) => effect.pointer.x),
      ).toEqual([130, 140]);
      h.controller.dispose();
    },
  );

  it("cancels an invalid mode-change sample and ignores disabled contact", () => {
    const h = harness();
    h.pointer.handlePointerDown(pen({ button: 0, buttons: 1, pressure: 0.5 }));
    h.pointer.handlePointerMove(pen({ buttons: 3, pressure: 0.5, clientX: Number.NaN }));
    expect(h.controls.input.interaction).toBeUndefined();
    expect(h.effects).toContainEqual({ type: "revert-preview", kind: "tool-gesture" });
    h.controls.enabled = false;
    const count = h.effects.length;
    h.pointer.handlePointerDown(pen({ buttons: 3, pressure: 0.5 }));
    h.pointer.handlePointerMove(pen({ buttons: 3, pressure: 0.5 }));
    expect(h.effects).toHaveLength(count);
    expect(h.capture).toHaveBeenCalledOnce();
    h.controller.dispose();
  });
});
