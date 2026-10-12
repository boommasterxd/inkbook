import { describe, expect, it } from "vitest";

import { createInputState, reduceInput } from "../../../../src/editor/input";
import {
  effectTypes,
  inputPhase,
  pointerDown,
  pointerMove,
} from "../../../fixtures/editor/input-actions";

describe("selection move threshold", () => {
  it.each([
    ["mouse", 2],
    ["pen", 2],
    ["touch", 6],
  ] as const)(
    "starts a selected %s move only beyond %s pixels with the complete delta",
    (pointerType, threshold) => {
      const started = reduceInput(
        createInputState({ activeTool: "select", hasSelection: true }),
        pointerDown({ pointerType, target: { elementId: "shape-a", isSelected: true } }),
      );
      const boundary = reduceInput(
        started.state,
        pointerMove({ pointerType, x: 10 + threshold, y: 20 }),
      );
      expect(boundary.effects).toEqual([]);
      const moved = reduceInput(
        boundary.state,
        pointerMove({ pointerType, x: 10 + threshold + 0.001, y: 20 }),
      );
      expect(effectTypes(moved.effects)).toEqual(
        pointerType === "touch"
          ? ["cancel-long-press", "begin-preview", "update-preview"]
          : ["begin-preview", "update-preview"],
      );
      expect(moved.effects[moved.effects.length - 1]).toMatchObject({
        kind: "element-move",
        pointer: { pointerType, x: 10 + threshold + 0.001, y: 20 },
      });
    },
  );

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

describe("Select tap and area arbitration", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "ignores invalid batch movement %s",
    (maximumMovement) => {
      const pending = reduceInput(createInputState({ activeTool: "select" }), pointerDown()).state;
      const moved = reduceInput(pending, pointerMove({ maximumMovement }));
      expect(moved).toEqual({ state: pending, effects: [] });
    },
  );

  it.each(["mouse", "pen"] as const)(
    "starts an area from an unselected %s target only beyond six screen pixels",
    (pointerType) => {
      const pending = reduceInput(
        createInputState({ activeTool: "select", hasSelection: true }),
        pointerDown({ pointerType, target: { elementId: "shape-b", isSelected: false } }),
      );
      expect(inputPhase(pending.state)).toBe("select-pending");
      expect(effectTypes(pending.effects)).toEqual(["capture-pointer"]);
      const boundary = reduceInput(pending.state, pointerMove({ pointerType, x: 16, y: 20 }));
      expect(boundary.effects).toEqual([]);
      const dragged = reduceInput(boundary.state, pointerMove({ pointerType, x: 16.001, y: 20 }));
      expect(inputPhase(dragged.state)).toBe("lasso");
      expect(effectTypes(dragged.effects)).toEqual([
        "clear-selection",
        "begin-preview",
        "update-preview",
      ]);
      expect(dragged.effects[1]).toMatchObject({
        kind: "lasso",
        pointer: { x: 10, y: 20 },
        additive: false,
      });
      const returned = reduceInput(dragged.state, pointerMove({ pointerType, x: 10, y: 20 }));
      expect(effectTypes(returned.effects)).toEqual(["update-preview"]);
      const released = reduceInput(returned.state, {
        type: "pointer-up",
        pointerId: 1,
        target: { elementId: "shape-b", isSelected: false },
      });
      expect(effectTypes(released.effects)).toEqual(["commit-preview", "release-pointer"]);
    },
  );

  it.each([
    [false, false, "replace"],
    [false, true, "replace"],
    [true, false, "add"],
    [true, true, "add"],
  ] as const)(
    "resolves a release target with Control/Command=%s Shift=%s as %s",
    (controlOrMeta, shift, mode) => {
      const pending = reduceInput(
        createInputState({ activeTool: "select", hasSelection: true }),
        pointerDown({ controlOrMeta, shift }),
      );
      const moved = reduceInput(pending.state, pointerMove({ x: 16, y: 20 }));
      const released = reduceInput(moved.state, {
        type: "pointer-up",
        pointerId: 1,
        target: { elementId: "shape-b", isSelected: false },
      });
      expect(released.effects).toEqual([
        { type: "select-element", elementId: "shape-b", mode },
        { type: "release-pointer", pointerId: 1 },
      ]);
      expect(released.state.interaction).toBeUndefined();
    },
  );

  it.each(["pointer-cancel", "lost-pointer-capture", "reset"] as const)(
    "preserves selection and releases a pending press on %s",
    (type) => {
      const pending = reduceInput(
        createInputState({ activeTool: "select", hasSelection: true }),
        pointerDown({ target: { elementId: "shape-b", isSelected: false } }),
      );
      const cancelled = reduceInput(pending.state, { type, pointerId: 1 });
      expect(cancelled.effects).toEqual([{ type: "release-pointer", pointerId: 1 }]);
      expect(cancelled.state.hasSelection).toBe(true);
      expect(cancelled.state.interaction).toBeUndefined();
    },
  );

  it("retains the initial selection for Shift areas independently of Control/Command", () => {
    const pending = reduceInput(
      createInputState({ activeTool: "select", hasSelection: true }),
      pointerDown({ shift: true, controlOrMeta: true }),
    );
    const ignored = reduceInput(pending.state, pointerMove({ pointerId: 2 }));
    expect(ignored.state).toBe(pending.state);
    const dragged = reduceInput(ignored.state, pointerMove());
    expect(dragged.state.hasSelection).toBe(true);
    expect(effectTypes(dragged.effects)).toEqual(["begin-preview", "update-preview"]);
    expect(dragged.effects[0]).toMatchObject({ kind: "lasso", additive: true });
  });
});
