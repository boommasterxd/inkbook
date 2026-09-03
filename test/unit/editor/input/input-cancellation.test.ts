import { describe, expect, it } from "vitest";

import {
  createInputState,
  reduceInput,
  type InputAction,
  type InputState,
} from "../../../../src/editor/input";
import { type InputEffect, type PointerDownAction } from "../../../../src/editor/input/input-types";
import { inputPhase } from "../../../fixtures/editor/input-actions";

function touchDown(overrides: Partial<PointerDownAction> = {}): PointerDownAction {
  return {
    type: "pointer-down",
    pointerId: 1,
    pointerType: "touch",
    x: 0,
    y: 0,
    button: 0,
    buttons: 1,
    controlOrMeta: false,
    shift: false,
    isPlatformContextClick: false,
    ...overrides,
  };
}

function apply(state: InputState, action: InputAction) {
  return reduceInput(state, action);
}

function types(effects: readonly InputEffect[]): string[] {
  return effects.map(({ type }) => type);
}

describe("input exit cleanup", () => {
  it("cancels the empty-canvas timer on release or cancellation", () => {
    for (const type of ["pointer-up", "pointer-cancel", "lost-pointer-capture"] as const) {
      const pending = apply(createInputState({ hasSelection: true }), touchDown());
      const exited = apply(pending.state, { type, pointerId: 1 });
      expect(inputPhase(exited.state)).toBe("idle");
      expect(exited.effects).toEqual([
        ...(type === "pointer-up" ? [{ type: "clear-selection" as const }] : []),
        { type: "cancel-long-press", pointerId: 1 },
        { type: "release-pointer", pointerId: 1 },
      ]);
    }
  });

  it("cancels an element timer without inventing a zero-distance commit", () => {
    const moving = apply(
      createInputState(),
      touchDown({ target: { elementId: "shape-a", isSelected: true } }),
    );
    const cancelled = apply(moving.state, { type: "pointer-cancel", pointerId: 1 });
    expect(types(cancelled.effects)).toEqual(["cancel-long-press", "release-pointer"]);
  });

  it("reverts an element move after its timer was cancelled by movement", () => {
    const moving = apply(
      createInputState(),
      touchDown({ target: { elementId: "shape-a", isSelected: true } }),
    );
    const preview = apply(moving.state, {
      type: "pointer-move",
      pointerId: 1,
      pointerType: "touch",
      x: 7,
      y: 0,
    });
    const cancelled = apply(preview.state, { type: "lost-pointer-capture", pointerId: 1 });
    expect(cancelled.effects).toEqual([
      { type: "revert-preview", kind: "element-move" },
      { type: "release-pointer", pointerId: 1 },
    ]);
  });

  it("reverts note scrolling on cancellation", () => {
    const pending = apply(createInputState({ zoom: 2, fitZoom: 1 }), touchDown());
    const scrolling = apply(pending.state, {
      type: "pointer-move",
      pointerId: 1,
      pointerType: "touch",
      x: 0,
      y: 11,
    });
    const cancelled = apply(scrolling.state, { type: "pointer-cancel", pointerId: 1 });
    expect(cancelled.effects).toEqual([
      { type: "revert-navigation", kind: "note-scroll" },
      { type: "release-pointer", pointerId: 1 },
    ]);
  });
});

describe("preview cancellation", () => {
  it("cancels a pen lasso preview without committing selection geometry", () => {
    const lasso = apply(
      createInputState({
        activeTool: "select",
        deviceFingerDrawingEnabled: true,
        toolbarFingerDrawingEnabled: true,
      }),
      touchDown({ pointerType: "pen" }),
    );
    const preview = apply(lasso.state, {
      type: "pointer-move",
      pointerId: 1,
      pointerType: "pen",
      x: 7,
      y: 0,
    });
    const cancelled = apply(preview.state, { type: "pointer-cancel", pointerId: 1 });
    expect(cancelled.effects).toEqual([
      { type: "revert-preview", kind: "lasso" },
      { type: "release-pointer", pointerId: 1 },
    ]);
  });

  it("reverts a finger tool preview before starting a second-touch pinch", () => {
    const tool = apply(
      createInputState({
        activeTool: "draw",
        deviceFingerDrawingEnabled: true,
        toolbarFingerDrawingEnabled: true,
      }),
      touchDown(),
    );
    const pinch = apply(tool.state, touchDown({ pointerId: 2, x: 20 }));
    expect(inputPhase(pinch.state)).toBe("pinch");
    expect(types(pinch.effects)).toEqual(["revert-preview", "capture-pointer", "begin-pinch"]);
  });

  it("ignores expired long-press actions after a gesture wins arbitration", () => {
    const pending = apply(createInputState({ zoom: 2, fitZoom: 1 }), touchDown());
    const panning = apply(pending.state, {
      type: "pointer-move",
      pointerId: 1,
      pointerType: "touch",
      x: 11,
      y: 0,
    });
    expect(apply(panning.state, { type: "long-press", pointerId: 1 })).toEqual({
      state: panning.state,
      effects: [],
    });
  });
});
