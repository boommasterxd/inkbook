import { expect, onTestFinished } from "vitest";

import { createInputState } from "../../../src/editor/input/index";
import { activeEditorPointerHarness } from "./active-editor-pointer";
import { timedCursorPointerEvent } from "./tool-cursor";

export function touchPanHarness() {
  const h = activeEditorPointerHarness();
  h.controls.input = createInputState({ fitZoom: 1, zoom: 2 });
  onTestFinished(() => h.controller.dispose());
  return h;
}

export function beginTouchPan(h: ReturnType<typeof touchPanHarness>): void {
  h.pointer.handlePointerDown(touchPanEvent(120, 0));
  h.pointer.handlePointerMove(touchPanEvent(150, 8));
  expect(h.controls.input.interaction?.phase).toBe("page-pan");
}

export function touchPanBatch(
  samples: PointerEvent[],
  getCoalescedEvents: () => PointerEvent[] = () => samples,
): PointerEvent {
  const last = samples[samples.length - 1]!;
  return touchPanEvent(last.clientX, last.timeStamp, { getCoalescedEvents });
}

export function touchPanEvent(
  x: number,
  timeStamp: number,
  overrides: Partial<PointerEvent> = {},
): PointerEvent {
  return timedCursorPointerEvent(timeStamp, {
    clientX: x,
    clientY: 80,
    pointerType: "touch",
    pointerId: 1,
    button: 0,
    buttons: 1,
    pressure: 0.5,
    ...overrides,
  });
}

export function expectCancelledTouchPan(h: ReturnType<typeof touchPanHarness>): void {
  expect(h.recordTouchPan).not.toHaveBeenCalled();
  expect(h.releaseTouchPan).not.toHaveBeenCalled();
  expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "pointer-cancel", pointerId: 1 });
  expect(h.cancelPanMomentum).toHaveBeenCalled();
  expect(h.controls.input.interaction).toBeUndefined();
  expect(h.release).toHaveBeenCalledWith(1);
}
