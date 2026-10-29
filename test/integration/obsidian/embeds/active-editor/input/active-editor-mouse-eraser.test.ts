import { describe, expect, it } from "vitest";

import { activeEditorPointerHarness as harness } from "../../../../../fixtures/obsidian/active-editor-pointer";
import { cursorPointerEvent as mouse } from "../../../../../fixtures/obsidian/tool-cursor";
import { indexedStroke } from "../../../../../fixtures/editor/stroke";

describe("hardware eraser reported as mouse input", () => {
  it.each([
    { phase: "down", button: 5, buttons: 1 },
    { phase: "down", button: 0, buttons: 33 },
    { phase: "move", button: -1, buttons: 32 },
  ] as const)("erases from $phase with button $button and buttons $buttons", (fields) => {
    const h = harness();
    h.controls.input = { ...h.controls.input, activeTool: "highlighter" };
    const event = mouse({ ...fields, pressure: 0.5 });
    if (fields.phase === "move") h.pointer.handlePointerMove(event);
    else h.pointer.handlePointerDown(event);

    expect(h.controls.input.interaction).toMatchObject({
      phase: "eraser-gesture",
      pointerType: "mouse",
      penRole: "eraser",
      previousTool: "highlighter",
    });
    expect(h.capture).toHaveBeenCalledExactlyOnceWith(1);
    expect(h.effects).toContainEqual(
      expect.objectContaining({ type: "begin-preview", tool: "eraser" }),
    );
    h.pointer.handlePointerMove(mouse({ buttons: fields.buttons, pressure: 0.5, clientX: 150 }));
    h.pointer.handlePointerUp(mouse({ button: 5, buttons: 0, clientX: 900 }));

    expect(
      h.effects
        .filter((effect) => effect.type === "update-preview")
        .map((effect) => effect.pointer.x),
    ).toEqual([130]);
    expect(h.effects).toContainEqual({ type: "commit-preview", kind: "eraser-gesture" });
    expect(h.effects).toContainEqual({ type: "restore-temporary-tool", tool: "highlighter" });
    expect(h.controls.input.interaction).toBeUndefined();
    h.pointer.handlePointerMove(mouse());
    expect(h.read().cursor?.kind).toBe("tool");
    expect(h.timers.size).toBe(0);
    h.pointer.handlePointerDown(mouse({ button: 0, buttons: 1, pressure: 0.5 }));
    expect(h.controls.input.interaction).toMatchObject({
      phase: "tool-gesture",
      tool: "highlighter",
    });
    h.controller.dispose();
  });

  it("switches during contact and retains capture until the tip lifts", () => {
    const h = harness();
    h.pointer.handlePointerDown(mouse({ button: 0, buttons: 1, pressure: 0.5 }));
    h.pointer.handlePointerMove(mouse({ button: 5, buttons: 33, pressure: 0.5 }));
    expect(h.effects).toContainEqual({ type: "revert-preview", kind: "tool-gesture" });
    expect(h.controls.input.interaction?.phase).toBe("eraser-gesture");
    h.pointer.handlePointerMove(mouse({ button: 5, buttons: 1, pressure: 0.5 }));
    expect(h.effects).toContainEqual({ type: "commit-preview", kind: "eraser-gesture" });
    expect(h.effects).toContainEqual({ type: "restore-temporary-tool", tool: "draw" });
    expect(h.controls.input.interaction).toBeUndefined();
    expect(h.release).not.toHaveBeenCalled();
    const completed = h.effects.length;
    h.pointer.handlePointerMove(mouse({ buttons: 1, pressure: 0.5 }));
    expect(h.effects).toHaveLength(completed);
    h.pointer.handlePointerUp(mouse());
    expect(h.release).toHaveBeenCalledWith(1);
    expect(h.controls.input.consumedPointerIds).toEqual([]);
    h.controller.dispose();
  });

  it.each(["cancel", "lost-capture"])(
    "reverts erasing on %s and restores normal input",
    (terminal) => {
      const h = harness();
      h.pointer.handlePointerDown(mouse({ button: 5, buttons: 32 }));
      if (terminal === "cancel") h.pointer.handlePointerCancel(mouse());
      else h.pointer.handleLostPointerCapture(mouse());
      expect(h.effects).toContainEqual({ type: "revert-preview", kind: "eraser-gesture" });
      expect(h.effects).toContainEqual({ type: "restore-temporary-tool", tool: "draw" });
      expect(h.controls.input.interaction).toBeUndefined();
      expect(h.release).toHaveBeenCalledWith(1);
      expect(h.timers.size).toBe(0);
      h.pointer.handlePointerDown(mouse({ button: 0, buttons: 1 }));
      expect(h.controls.input.interaction?.phase).toBe("tool-gesture");
      h.controller.dispose();
    },
  );

  it.each([
    { button: 2, buttons: 2 },
    { button: 1, buttons: 4 },
  ])("keeps ordinary mouse button $button out of erasing", (fields) => {
    const h = harness();
    h.pointer.handlePointerDown(mouse(fields));
    expect(h.controls.input.interaction).toBeUndefined();
    expect(h.effects).toEqual([]);
    expect(h.capture).not.toHaveBeenCalled();
    h.controller.dispose();
  });
});

it("preserves the selection tool instead of activating temporary erase", () => {
  const stroke = indexedStroke(0);
  const h = harness([stroke]);
  h.controls.input = { ...h.controls.input, activeTool: "select" };
  h.pointer.handlePointerDown(mouse({ button: 5, buttons: 32, clientX: 40, clientY: 50 }));
  expect(h.controls.input.interaction).toMatchObject({ phase: "select-pending", tool: "select" });
  expect(h.effects).not.toContainEqual(
    expect.objectContaining({ type: "activate-temporary-eraser" }),
  );
  h.pointer.handlePointerUp(mouse({ button: 5, buttons: 0, clientX: 900, clientY: 700 }));
  expect(h.effects).toContainEqual({
    type: "select-element",
    elementId: stroke.id,
    mode: "replace",
  });
  expect(h.effects).not.toContainEqual(
    expect.objectContaining({ type: "begin-preview", kind: "lasso" }),
  );
  h.controller.dispose();
});
