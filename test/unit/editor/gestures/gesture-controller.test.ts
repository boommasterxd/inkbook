import { describe, expect, it } from "vitest";

import type { InputReduction } from "../../../../src/editor/input/input-types";
import { createGestureControllerHarness } from "../../../fixtures/editor/gesture-controller";

const state = {
  activeTool: "draw" as const,
  deviceFingerDrawingEnabled: false,
  toolbarFingerDrawingEnabled: false,
  hasSelection: false,
  zoom: 1,
  fitZoom: 1,
  interaction: undefined,
  consumedPointerIds: [],
};

describe("gesture controller", () => {
  it("updates and commits one active preview exactly once", () => {
    const { controller, preview } = createGestureControllerHarness();
    const pointer = { pointerId: 1, pointerType: "pen" as const, x: 2, y: 3 };
    controller.apply({
      state,
      effects: [
        { type: "begin-preview", kind: "tool-gesture", tool: "draw", pointer, additive: false },
      ],
    });
    controller.apply({
      state,
      effects: [{ type: "update-preview", kind: "tool-gesture", pointer }],
    });
    controller.apply({ state, effects: [{ type: "commit-preview", kind: "tool-gesture" }] });
    expect(preview.update).toHaveBeenCalledOnce();
    expect(preview.commit).toHaveBeenCalledOnce();
    expect(preview.revert).not.toHaveBeenCalled();
  });

  it("reverts a preview on cancellation and rejects a second terminal effect", () => {
    const { controller, preview } = createGestureControllerHarness();
    const begin: InputReduction = {
      state,
      effects: [
        {
          type: "begin-preview",
          kind: "element-move",
          tool: "select",
          pointer: { pointerId: 2, pointerType: "touch", x: 1, y: 1 },
          additive: false,
        },
      ],
    };
    controller.apply(begin);
    controller.apply({ state, effects: [{ type: "revert-preview", kind: "element-move" }] });
    expect(preview.revert).toHaveBeenCalledOnce();
    expect(() =>
      controller.apply({ state, effects: [{ type: "commit-preview", kind: "element-move" }] }),
    ).toThrow();
  });
});
