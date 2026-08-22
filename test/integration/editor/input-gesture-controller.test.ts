import { describe, expect, it } from "vitest";

import { createInputState, reduceInput } from "../../../src/editor/input";
import { createGestureControllerHarness } from "../../fixtures/editor/gesture-controller";

function pointer(type: "pointer-down" | "pointer-move", x: number, y: number) {
  return type === "pointer-down"
    ? {
        type,
        pointerId: 1,
        pointerType: "pen" as const,
        x,
        y,
        pressure: 0.5,
        button: 0,
        buttons: 1,
        controlOrMeta: false,
        shift: false,
        isPlatformContextClick: false,
      }
    : { type, pointerId: 1, pointerType: "pen" as const, x, y, pressure: 0.5 };
}

describe("input reducer and gesture controller", () => {
  it("turns one pointer gesture into exactly one commit", () => {
    const { controller, preview } = createGestureControllerHarness();
    let state = createInputState();
    for (const action of [
      pointer("pointer-down", 10, 10),
      pointer("pointer-move", 20, 20),
    ] as const) {
      const reduction = reduceInput(state, action);
      state = reduction.state;
      controller.apply(reduction);
    }
    const release = reduceInput(state, { type: "pointer-up", pointerId: 1 });
    controller.apply(release);
    expect(preview.update).toHaveBeenCalledOnce();
    expect(preview.commit).toHaveBeenCalledOnce();
    expect(preview.revert).not.toHaveBeenCalled();
  });

  it("reverts the uncommitted preview on lost capture", () => {
    const { controller, preview, releasePointer } = createGestureControllerHarness();
    const down = reduceInput(createInputState(), pointer("pointer-down", 10, 10));
    controller.apply(down);
    controller.apply(reduceInput(down.state, { type: "lost-pointer-capture", pointerId: 1 }));
    expect(preview.revert).toHaveBeenCalledOnce();
    expect(preview.commit).not.toHaveBeenCalled();
    expect(releasePointer).toHaveBeenCalledWith(1);
  });

  it("cancels the imperative preview before accepting input after disable and re-enable", () => {
    const { controller, preview } = createGestureControllerHarness();
    const started = reduceInput(createInputState(), pointer("pointer-down", 10, 10));
    controller.apply(started);

    const reset = reduceInput(started.state, { type: "reset" });
    controller.apply(reset);

    expect(reset.state.interaction).toBeUndefined();
    expect(preview.revert).toHaveBeenCalledOnce();

    const restarted = reduceInput(reset.state, pointer("pointer-down", 20, 20));
    controller.apply(restarted);
    expect(restarted.state.interaction?.phase).toBe("tool-gesture");
    expect(preview.revert).toHaveBeenCalledOnce();
  });
});
