import { describe, expect, it } from "vitest";

import {
  createInputState,
  inputPhase,
  reduceInput,
  type InputEffect,
  type PointerMoveAction,
} from "../../../../src/editor/input";
import { pointerDown } from "../../../fixtures/editor/input-actions";

function pointerMove(overrides: Partial<PointerMoveAction> = {}): PointerMoveAction {
  return {
    type: "pointer-move",
    pointerId: 1,
    pointerType: "touch",
    x: 10,
    y: 20,
    pressure: 0.5,
    ...overrides,
  };
}

function effectTypes(effects: readonly InputEffect[]): string[] {
  return effects.map(({ type }) => type);
}

describe("selection deselection", () => {
  it.each(["draw", "eraser", "line", "arrow", "rectangle"] as const)(
    "clears an existing selection before a primary %s gesture outside it",
    (activeTool) => {
      const started = reduceInput(
        createInputState({ activeTool, hasSelection: true }),
        pointerDown(),
      );
      expect(started.state.hasSelection).toBe(false);
      expect(effectTypes(started.effects)).toEqual([
        "capture-pointer",
        "clear-selection",
        "begin-preview",
      ]);
    },
  );

  it("still clears a Shift-modified drawing gesture outside the selection", () => {
    const started = reduceInput(
      createInputState({ activeTool: "draw", hasSelection: true }),
      pointerDown({ shift: true }),
    );
    expect(started.effects).toContainEqual({ type: "clear-selection" });
  });

  it("clears on Select pointer-down without emitting a second clear on release", () => {
    const started = reduceInput(
      createInputState({ activeTool: "select", hasSelection: true }),
      pointerDown(),
    );
    const released = reduceInput(started.state, { type: "pointer-up", pointerId: 1 });
    expect(started.effects).toContainEqual({ type: "clear-selection" });
    expect(released.effects).toEqual([{ type: "release-pointer", pointerId: 1 }]);
    expect(released.state.hasSelection).toBe(false);
  });

  it("replaces the selection when clicking an unselected element", () => {
    const started = reduceInput(
      createInputState({ activeTool: "select", hasSelection: true }),
      pointerDown({ target: { elementId: "shape-b", isSelected: false } }),
    );
    expect(effectTypes(started.effects)).toEqual(["capture-pointer", "select-element"]);
    expect(started.effects).toContainEqual({
      type: "select-element",
      elementId: "shape-b",
      mode: "replace",
    });
  });

  it("adds an unselected element for a Control or Command click", () => {
    const started = reduceInput(
      createInputState({ activeTool: "select", hasSelection: true }),
      pointerDown({
        controlOrMeta: true,
        target: { elementId: "shape-b", isSelected: false },
      }),
    );
    expect(started.effects).toContainEqual({
      type: "select-element",
      elementId: "shape-b",
      mode: "add",
    });
  });

  it("replaces the selection for a Shift click instead of treating Shift as additive", () => {
    const started = reduceInput(
      createInputState({ activeTool: "select", hasSelection: true }),
      pointerDown({
        shift: true,
        target: { elementId: "shape-b", isSelected: false },
      }),
    );
    expect(started.effects).toContainEqual({
      type: "select-element",
      elementId: "shape-b",
      mode: "replace",
    });
  });

  it("clears for a normal pen outside but preserves its selected target", () => {
    const state = createInputState({ activeTool: "arrow", hasSelection: true });
    const outside = reduceInput(state, pointerDown({ pointerType: "pen" }));
    const selectedTarget = reduceInput(
      state,
      pointerDown({
        pointerType: "pen",
        target: { elementId: "shape-a", isSelected: true },
      }),
    );

    expect(effectTypes(outside.effects)).toEqual([
      "capture-pointer",
      "clear-selection",
      "begin-preview",
    ]);
    expect(effectTypes(selectedTarget.effects)).toEqual(["capture-pointer"]);
    expect(inputPhase(selectedTarget.state)).toBe("element-move");
    expect(selectedTarget.state.hasSelection).toBe(true);
  });
});

describe("touch selection deselection", () => {
  it("clears selection when a claimed finger drawing starts outside it", () => {
    const started = reduceInput(
      createInputState({
        activeTool: "draw",
        hasSelection: true,
        deviceFingerDrawingEnabled: true,
        toolbarFingerDrawingEnabled: true,
      }),
      pointerDown({ pointerType: "touch" }),
    );
    expect(started.state.hasSelection).toBe(false);
    expect(inputPhase(started.state)).toBe("tool-gesture");
    expect(effectTypes(started.effects)).toEqual([
      "capture-pointer",
      "clear-selection",
      "begin-preview",
    ]);

    const moved = reduceInput(started.state, pointerMove({ x: 20, y: 24 }));
    expect(moved.state.hasSelection).toBe(false);
    expect(effectTypes(moved.effects)).toEqual(["update-preview"]);

    const committed = reduceInput(moved.state, { type: "pointer-up", pointerId: 1 });
    expect(committed.state.hasSelection).toBe(false);
    expect(effectTypes(committed.effects)).toEqual(["commit-preview", "release-pointer"]);
  });

  it("keeps selection when a claimed finger preview becomes a pinch", () => {
    const first = reduceInput(
      createInputState({
        activeTool: "draw",
        hasSelection: true,
        deviceFingerDrawingEnabled: true,
        toolbarFingerDrawingEnabled: true,
      }),
      pointerDown({ pointerType: "touch" }),
    );
    const moved = reduceInput(first.state, pointerMove({ x: 20, y: 24 }));
    const pinch = reduceInput(
      moved.state,
      pointerDown({ pointerId: 2, pointerType: "touch", x: 30 }),
    );

    expect(pinch.state.hasSelection).toBe(false);
    expect(effectTypes(pinch.effects)).toEqual([
      "revert-preview",
      "capture-pointer",
      "begin-pinch",
    ]);
  });
});

describe("touch tap selection deselection", () => {
  it("keeps a universal unselected-element touch tap pending while finger drawing is enabled", () => {
    const started = reduceInput(
      createInputState({
        activeTool: "draw",
        hasSelection: true,
        deviceFingerDrawingEnabled: true,
        toolbarFingerDrawingEnabled: true,
      }),
      pointerDown({
        pointerType: "touch",
        target: { elementId: "shape-b", isSelected: false },
      }),
    );

    expect(inputPhase(started.state)).toBe("touch-pending");
    expect(effectTypes(started.effects)).not.toContain("clear-selection");
    expect(reduceInput(started.state, { type: "pointer-up", pointerId: 1 }).effects).toContainEqual(
      {
        type: "select-element",
        elementId: "shape-b",
        mode: "replace",
      },
    );
  });

  it("waits for a confirmed empty touch tap before clearing selection", () => {
    const pending = reduceInput(
      createInputState({ hasSelection: true }),
      pointerDown({ pointerType: "touch", timestamp: 100 }),
    );
    expect(effectTypes(pending.effects)).toEqual(["capture-pointer", "schedule-long-press"]);
    const moved = reduceInput(pending.state, pointerMove({ x: 10, y: 31 }));
    expect(effectTypes(moved.effects)).toEqual(["cancel-long-press", "scroll-note"]);
    const released = reduceInput(moved.state, {
      type: "pointer-up",
      pointerId: 1,
      timestamp: 200,
    });
    expect(effectTypes(released.effects)).not.toContain("clear-selection");

    const tap = reduceInput(
      createInputState({ hasSelection: true }),
      pointerDown({ pointerType: "touch", timestamp: 100 }),
    );
    const tapped = reduceInput(tap.state, {
      type: "pointer-up",
      pointerId: 1,
      timestamp: 200,
    });
    expect(effectTypes(tapped.effects)).toEqual([
      "clear-selection",
      "cancel-long-press",
      "release-pointer",
    ]);
    expect(tapped.state.hasSelection).toBe(false);
  });
});
