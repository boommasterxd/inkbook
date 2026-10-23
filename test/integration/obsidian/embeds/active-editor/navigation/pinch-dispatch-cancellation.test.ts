import { describe, expect, it, vi } from "vitest";
import { GestureController } from "../../../../../../src/editor/gestures/public";
import { applyInputAction } from "../../../../../../src/obsidian/embeds/active-editor/input/controller-dispatch";
import type { EditableDocumentModel } from "../../../../../../src/obsidian/embeds/document-session/vault-document-session";
import type {
  BrowserScrollElement,
  PenScrollGuard,
} from "../../../../../../src/obsidian/scrolling/index";
import { gestureControllerPorts } from "../../../../../fixtures/obsidian/active-editor";
import { createNavigationHarness } from "../../../../../fixtures/obsidian/navigation";
import { pointerDown, pointerMove } from "../../../../../fixtures/editor/input-actions";

describe("input dispatcher pinch cancellation", () => {
  it.each(["pointer-cancel", "reset"] as const)(
    "returns the restored camera zoom and clean reducer state after %s effects",
    (type) => {
      const harness = createNavigationHarness();
      harness.navigation.restoreViewState({ cameraX: -100, zoom: 1 });
      const origin = harness.navigation.getViewState();
      const setGestureActive = vi.fn();
      const model = { setGestureActive } as unknown as EditableDocumentModel;
      const penGuard = { stop: vi.fn() } as unknown as PenScrollGuard<BrowserScrollElement>;
      const gestures = new GestureController(
        gestureControllerPorts(
          () => {
            throw new Error("A pinch must not start a drawing preview.");
          },
          {
            beginPinch: (anchor) => harness.navigation.beginPinchScreen(anchor),
            updatePinch: (anchor, scale) => harness.navigation.updatePinchScreen(anchor, scale),
            revertPinch: () => harness.navigation.revert(),
            finishPinch: () => harness.navigation.finish(),
          },
        ),
      );
      let input = harness.state();
      for (const action of [
        pointerDown({ pointerType: "touch", x: 400, y: 300 }),
        pointerDown({ pointerType: "touch", pointerId: 2, x: 440, y: 300 }),
        pointerMove({ pointerType: "touch", pointerId: 2, x: 480, y: 300 }),
      ]) {
        input = applyInputAction(input, action, gestures, model, penGuard, harness.navigation);
      }
      harness.frames.flushOne();
      input = { ...input, zoom: harness.navigation.zoom };
      expect(input.zoom).toBe(2);
      const cancelled = applyInputAction(
        input,
        type === "reset" ? { type } : { type, pointerId: 2 },
        gestures,
        model,
        penGuard,
        harness.navigation,
      );
      expect(harness.navigation.getViewState()).toEqual(origin);
      expect(cancelled.zoom).toBe(origin.zoom);
      expect(cancelled.fitZoom).toBe(input.fitZoom);
      expect(cancelled.interaction).toBeUndefined();
      expect(harness.frames.pending).toBe(0);
      expect(setGestureActive).toHaveBeenLastCalledWith(false);
      harness.navigation.dispose();
    },
  );
});
