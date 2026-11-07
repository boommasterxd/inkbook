import { expect, it, vi } from "vitest";
import { createInputState, reduceInput, type InputAction } from "../../../../../src/editor/input";
import { GestureController } from "../../../../../src/editor/gestures/public";
import { OUTER_PAGE_WIDTH } from "../../../../../src/editor/zoom/zoom";
import { ActiveEditorNavigation } from "../../../../../src/obsidian/embeds/active-editor/navigation/navigation";
import { gestureControllerPorts } from "../../../../fixtures/obsidian/active-editor";
import { buildNavigationHarness } from "../../../../fixtures/obsidian/navigation-refresh-profile";
import { pointerDown, pointerMove } from "../../../../fixtures/editor/input-actions";
import { INTERACTION_REFRESH_PROFILE } from "../../../interaction-refresh-profile";

function navigationHarness() {
  return buildNavigationHarness(
    { ActiveEditorNavigation, createInputState, OUTER_PAGE_WIDTH },
    INTERACTION_REFRESH_PROFILE.refreshRate,
  );
}

// These input contracts observe real navigation layout/scroll/camera boundaries.
// Full-scene capacity and indexed culling remain covered by navigation-index-work.
it.each(["horizontal", "vertical"])(
  "coalesces a secondary %s burst without editing or a tail",
  (axis) => {
    const h = navigationHarness();
    h.navigation.restoreViewState({ cameraX: -200, zoom: 1 });
    h.navigation.beginGestureGeometry();
    h.resetWrites();
    const menu = vi.fn();
    const preview = vi.fn(() => {
      throw new Error("Navigation must not create a preview.");
    });
    const gestures = new GestureController(
      gestureControllerPorts(preview, {
        openContextMenu: menu,
        panPage: (x, y) => {
          if (x !== 0) h.navigation.pan(x);
          if (y !== undefined && y !== 0) h.navigation.scroll(y);
        },
      }),
    );
    let input = createInputState();
    const dispatch = (action: InputAction) => {
      const result = reduceInput(input, action);
      input = result.state;
      gestures.apply(result);
    };
    try {
      dispatch(pointerDown({ button: 2, buttons: 2, x: 0, y: 0 }));
      for (let sample = 0; sample < 128; sample += 1) {
        const distance = 20 + sample;
        dispatch(
          pointerMove({
            x: axis === "horizontal" ? distance : 0,
            y: axis === "vertical" ? distance : 0,
          }),
        );
      }
      dispatch({ type: "pointer-up", pointerId: 1 });
      h.navigation.finish();
      expect(h.frames.pending).toBe(1);
      expect(h.layoutReads).toBe(0);
      expect(h.cameraWrites).toBe(0);
      h.frames.flush();
      expect(h.layoutReads).toBe(1);
      expect(h.hostBoundsReads).toEqual({ container: 1, owner: 1 });
      expect(h.cameraWrites).toBe(1);
      expect(h.layoutWrites).toBe(0);
      expect(h.inputWrites()).toBe(0);
      expect(h.scrollWrites).toBe(axis === "vertical" ? 1 : 0);
      expect(h.scrollReads).toBeLessThanOrEqual(axis === "vertical" ? 3 : 2);
      expect(h.navigation.cameraX).toBe(axis === "horizontal" ? -53 : -200);
      expect(h.owner.scrollTop).toBe(axis === "vertical" ? 53 : 200);
      expect(h.frames.pending).toBe(0);
      expect(h.frames.maxPending).toBe(1);
      expect(menu).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
    } finally {
      h.navigation.dispose();
    }
    expect(h.frames.pendingTimers).toBe(0);
  },
);

it("publishes calibrated modifier-scroll bursts once without replay work", () => {
  const h = navigationHarness();
  const fit = h.navigation.zoom;
  try {
    for (let sample = 0; sample < 100; sample += 1) {
      h.navigation.updateWheel(
        { clientX: 500, clientY: 300, deltaY: -1, deltaMode: 0, ctrlKey: true },
        true,
      );
    }
    expect(h.frames.pending).toBe(1);
    expect(h.layoutReads).toBe(0);
    h.frames.flush();
    expect(h.navigation.zoom).toBeCloseTo(fit * 1.12);
    expect(h.layoutReads).toBe(1);
    expect(h.cameraWrites).toBe(1);
    expect(h.scrollWrites).toBe(1);
    expect(h.layoutWrites).toBe(1);
    expect(h.scrollReads).toBe(2);
    expect(h.frames.pending).toBe(0);
  } finally {
    h.navigation.dispose();
  }
  expect(h.frames.pendingTimers).toBe(0);
});
