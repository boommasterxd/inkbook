// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { OUTER_PAGE_WIDTH } from "../../../../../src/editor/zoom/zoom";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { installNativeMenuMeasurementStyles } from "../../../../adapters/obsidian/editor-toolbar-menu";
import { createHarness, createDiv } from "../../../../fixtures/obsidian/active-controller";

beforeEach(() => {
  installObsidianDomHelpers();
  installNativeMenuMeasurementStyles();
});

function touch(
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerId: number,
  clientX: number,
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    pointerId,
    pointerType: "touch",
    clientX,
    clientY: 300,
  });
  Object.defineProperty(event, "isPrimary", { value: pointerId % 2 === 1 });
  return event;
}

async function applyTouchPinch(harness: ReturnType<typeof createHarness>): Promise<void> {
  harness.controller.handlePointerDown(touch("pointerdown", 7, 400));
  harness.controller.handlePointerDown(touch("pointerdown", 8, 440));
  harness.controller.handlePointerMove(touch("pointermove", 8, 480));
  await vi.advanceTimersByTimeAsync(32);
  expect(harness.controller.getViewState().zoom).toBeCloseTo(2);
}

describe("active touch pinch lifecycle interruption", () => {
  it("restores the applied pinch camera when Escape cancels the gesture", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const origin = harness.controller.getViewState();
      harness.controller.handlePointerBoundary(true);
      await applyTouchPinch(harness);
      expect(harness.key("Escape").defaultPrevented).toBe(true);
      expect(harness.controller.getViewState()).toEqual(origin);
      expect(harness.capture.release).toHaveBeenCalledWith(7);
      expect(harness.capture.release).toHaveBeenCalledWith(8);
    } finally {
      harness.dispose();
      vi.useRealTimers();
    }
  });
  it.each(["resize", "owner", "setZoom", "restore"] as const)(
    "cleans the reducer and captures on %s before old contacts move again",
    async (boundary) => {
      vi.useFakeTimers();
      const harness = createHarness();
      const replacementOwner = createDiv();
      try {
        await applyTouchPinch(harness);
        const fitZoom = 800 / OUTER_PAGE_WIDTH;
        if (boundary === "resize")
          harness.controller.applyResize({ cameraX: -100, fitZoom, zoom: 1.2 });
        else if (boundary === "owner") harness.controller.transferScrollOwner(replacementOwner);
        else if (boundary === "setZoom") harness.controller.setZoom(1.2);
        else harness.controller.restoreViewState({ cameraX: -100, zoom: 1.2 });
        const interrupted = harness.controller.getViewState();
        expect(harness.capture.release).toHaveBeenCalledWith(7);
        expect(harness.capture.release).toHaveBeenCalledWith(8);
        expect(harness.input.hasPointerCapture(7)).toBe(false);
        expect(harness.input.hasPointerCapture(8)).toBe(false);
        harness.renderer.setCamera.mockClear();
        harness.controller.handlePointerMove(touch("pointermove", 8, 480));
        await vi.advanceTimersByTimeAsync(32);
        expect(harness.controller.getViewState()).toEqual(interrupted);
        expect(harness.renderer.setCamera).not.toHaveBeenCalled();
        harness.controller.handlePointerUp(touch("pointerup", 7, 400));
        harness.controller.handlePointerUp(touch("pointerup", 8, 480));
      } finally {
        harness.dispose();
        replacementOwner.remove();
        vi.useRealTimers();
      }
    },
  );
});
