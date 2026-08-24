import { describe, expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../src/domain/store/public";
import { GestureController } from "../../../../src/editor/gestures/public";
import { createInputState, reduceInput, type InputState } from "../../../../src/editor/input/index";
import { CreationPreview } from "../../../../src/obsidian/embeds/active-editor/creation-preview";
import {
  activeEditorStoreHistory,
  creationPreviewRenderer,
  gestureControllerPorts,
} from "../../../fixtures/obsidian/active-editor";

describe("active editor viewport clipping", () => {
  it("finishes and accepts another gesture after a highlighter crosses the page edge", () => {
    const store = new ElementStore();
    const history = activeEditorStoreHistory(store);
    const releasePointer = vi.fn();
    let identity = 40;
    const controller = new GestureController(
      gestureControllerPorts(
        (start) =>
          new CreationPreview({
            defaults: createBuiltInSettings().toolDefaults,
            history,
            identity: {
              createdAt: identity,
              id: `00000000-0000-4000-8000-${String(identity++).padStart(12, "0")}`,
            },
            renderer: creationPreviewRenderer(),
            start,
          }),
        { releasePointer },
      ),
    );
    let state = createInputState({ activeTool: "highlighter" });

    expect(() => {
      state = applyPenGesture(controller, state, 7, 100, 3_000);
      state = applyPenGesture(controller, state, 8, 200, 300);
    }).not.toThrow();

    expect(state.interaction).toBeUndefined();
    expect(store.size).toBe(2);
    expect(store.get("00000000-0000-4000-8000-000000000040")?.bounds.maxX).toBe(3_010);
    expect(releasePointer).toHaveBeenCalledWith(7);
    expect(releasePointer).toHaveBeenCalledWith(8);
  });
});

function applyPenGesture(
  controller: GestureController,
  initialState: InputState,
  pointerId: number,
  startX: number,
  endX: number,
): InputState {
  let state = initialState;
  for (const action of [
    {
      type: "pointer-down" as const,
      pointerId,
      pointerType: "pen" as const,
      x: startX,
      y: 100,
      pressure: 0.5,
      button: 0,
      buttons: 1,
      controlOrMeta: false,
      isPlatformContextClick: false,
      shift: false,
    },
    {
      type: "pointer-move" as const,
      pointerId,
      pointerType: "pen" as const,
      x: endX,
      y: 100,
      pressure: 0.5,
    },
    { type: "pointer-up" as const, pointerId },
  ]) {
    const reduction = reduceInput(state, action);
    state = reduction.state;
    controller.apply(reduction);
  }
  return state;
}
