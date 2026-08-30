import { describe, expect, it } from "vitest";

import {
  createInputState,
  inputPhase,
  reduceInput,
  type InputEffect,
  type PointerMoveAction,
} from "../../../../src/editor/input";
import { pointerDown } from "../../../fixtures/editor/input-actions";

const pointerMove = (): PointerMoveAction => ({
  type: "pointer-move",
  pointerId: 1,
  pointerType: "mouse",
  x: 20,
  y: 30,
  pressure: 0.5,
});

const effectTypes = (effects: readonly InputEffect[]): string[] => effects.map(({ type }) => type);

describe("selection move threshold", () => {
  it("applies the complete pointer delta in the first threshold-crossing move frame", () => {
    const started = reduceInput(
      createInputState({ activeTool: "select", hasSelection: true }),
      pointerDown({ target: { elementId: "shape-a", isSelected: true } }),
    );
    const moved = reduceInput(started.state, pointerMove());

    expect(effectTypes(moved.effects)).toEqual(["begin-preview", "update-preview"]);
    expect(moved.effects[1]).toMatchObject({
      kind: "element-move",
      pointer: { pointerId: 1, pointerType: "mouse", x: 20, y: 30 },
    });
  });

  it.each([
    ["draw", "mouse"],
    ["rectangle", "pen"],
    ["arrow", "touch"],
  ] as const)(
    "moves an existing selection with %s active and a %s pointer",
    (activeTool, pointerType) => {
      const started = reduceInput(
        createInputState({ activeTool, hasSelection: true }),
        pointerDown({
          pointerType,
          target: { elementId: "shape-a", isSelected: true },
        }),
      );

      expect(inputPhase(started.state)).toBe("element-move");
      expect(started.state.hasSelection).toBe(true);
      expect(effectTypes(started.effects)).toEqual(
        pointerType === "touch" ? ["capture-pointer", "schedule-long-press"] : ["capture-pointer"],
      );
    },
  );

  it("keeps a temporary eraser press on a selection destructive", () => {
    const started = reduceInput(
      createInputState({ activeTool: "draw", hasSelection: true }),
      pointerDown({
        controlOrMeta: true,
        target: { elementId: "shape-a", isSelected: true },
      }),
    );

    expect(inputPhase(started.state)).toBe("eraser-gesture");
    expect(effectTypes(started.effects)).toEqual([
      "capture-pointer",
      "activate-temporary-eraser",
      "begin-preview",
    ]);
  });
});
