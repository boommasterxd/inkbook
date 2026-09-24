import { describe, expect, it } from "vitest";

import { createInputState, reduceInput } from "../../../../src/editor/input";
import type {
  InputState,
  PenModeChangeAction,
  PointerDownAction,
} from "../../../../src/editor/input/input-types";
import { pointerDown, pointerMove } from "../../../fixtures/editor/input-actions";

function penMode(overrides: Partial<PenModeChangeAction> = {}): PenModeChangeAction {
  return {
    ...pointerMove({ pointerType: "pen" }),
    type: "pen-mode-change",
    penRole: "side-button",
    controlOrMeta: false,
    shift: false,
    ...overrides,
  };
}

function startedPen(
  overrides: Partial<PointerDownAction> = {},
  initial: InputState = createInputState(),
): InputState {
  return reduceInput(initial, pointerDown({ pointerType: "pen", ...overrides })).state;
}

describe("pen mode changes during contact", () => {
  it.each(["side-button", "eraser"] as const)(
    "cancels drawing before starting %s erasing at the current point without recapturing",
    (penRole) => {
      const state = startedPen({}, createInputState({ activeTool: "highlighter" }));
      const changed = reduceInput(state, penMode({ penRole, x: 40, y: 50 }));
      expect(changed.state.interaction).toMatchObject({
        phase: "eraser-gesture",
        start: { x: 40, y: 50 },
        current: { x: 40, y: 50 },
        penRole,
        previousTool: "highlighter",
        tool: "eraser",
        temporaryEraser: true,
      });
      expect(changed.effects).toEqual([
        { type: "revert-preview", kind: "tool-gesture" },
        { type: "activate-temporary-eraser", previousTool: "highlighter" },
        {
          type: "begin-preview",
          kind: "eraser-gesture",
          tool: "eraser",
          pointer: { pointerId: 1, pointerType: "pen", x: 40, y: 50, pressure: 0.5 },
          additive: false,
        },
      ]);
      expect(reduceInput(changed.state, penMode({ penRole }))).toEqual({
        state: changed.state,
        effects: [],
      });
    },
  );

  it.each(["pointer-up", "pointer-cancel"] as const)(
    "retains capture and suppresses contact after eraser release until %s",
    (type) => {
      const erasing = startedPen({ penRole: "side-button", buttons: 3 });
      const released = reduceInput(erasing, penMode({ penRole: "normal", x: 500 }));
      expect(released.state.interaction).toBeUndefined();
      expect(released.state.consumedPointerIds).toEqual([1]);
      expect(released.effects).toEqual([
        { type: "commit-preview", kind: "eraser-gesture" },
        { type: "restore-temporary-tool", tool: "draw" },
      ]);
      let state = released.state;
      for (const action of [
        { type: "lost-pointer-capture" as const, pointerId: 1 },
        pointerMove({ pointerType: "pen" }),
        penMode(),
        pointerDown({ pointerType: "pen" }),
      ]) {
        const ignored = reduceInput(state, action);
        expect(ignored).toEqual({ state, effects: [] });
        state = ignored.state;
      }
      const lifted = reduceInput(state, { type, pointerId: 1 });
      expect(lifted.state.consumedPointerIds).toEqual([]);
      expect(lifted.effects).toEqual([{ type: "release-pointer", pointerId: 1 }]);
      expect(startedPen({}, lifted.state).interaction?.phase).toBe("tool-gesture");
    },
  );
});

describe("pen mode ownership and cleanup", () => {
  it("releases retained contact capture on reset", () => {
    const erasing = startedPen({ penRole: "side-button" });
    const stopped = reduceInput(erasing, penMode({ penRole: "normal" }));
    const reset = reduceInput(stopped.state, { type: "reset" });
    expect(reset.state.consumedPointerIds).toEqual([]);
    expect(reset.effects).toEqual([{ type: "release-pointer", pointerId: 1 }]);
  });

  it.each([
    { penRole: "normal" as const, controlOrMeta: true },
    { penRole: "side-button" as const, controlOrMeta: true },
  ])("preserves the control-modifier eraser for %o", (overrides) => {
    const state = startedPen(overrides);
    expect(reduceInput(state, penMode({ penRole: "normal", controlOrMeta: true }))).toEqual({
      state,
      effects: [],
    });
  });

  it("keeps a control-origin eraser active after control is released", () => {
    const state = startedPen({ controlOrMeta: true });
    expect(reduceInput(state, penMode({ penRole: "normal" }))).toEqual({ state, effects: [] });
  });

  it.each([
    { pointerId: 2 },
    { pointerType: "mouse" as const },
    { pointerType: "touch" as const },
    { x: Number.NaN },
    { pressure: 2 },
    { penRole: "normal" as const },
  ])("ignores foreign, non-pen, invalid and unchanged input %o", (overrides) => {
    const state = startedPen();
    expect(reduceInput(state, penMode(overrides))).toEqual({ state, effects: [] });
  });

  it("does not change idle, selection, mouse or permanent eraser interactions", () => {
    for (const state of [
      createInputState(),
      startedPen({}, createInputState({ activeTool: "select" })),
      startedPen({ pointerType: "mouse" }),
      startedPen({}, createInputState({ activeTool: "eraser" })),
      startedPen({ penRole: "side-button" }, createInputState({ activeTool: "eraser" })),
      startedPen({ target: { elementId: "selected", isSelected: true } }),
    ]) {
      expect(reduceInput(state, penMode())).toEqual({ state, effects: [] });
      expect(reduceInput(state, penMode({ penRole: "normal" }))).toEqual({ state, effects: [] });
    }
  });
});
