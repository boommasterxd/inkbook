import { describe, expect, it } from "vitest";

import {
  DEFAULT_WHEEL_LINE_HEIGHT,
  DEFAULT_WHEEL_PAGE_HEIGHT,
  MAX_FRAME_ZOOM_FACTOR,
  TRACKPAD_ZOOM_DELTA_LIMIT,
  TRACKPAD_ZOOM_PIXELS_PER_STEP,
  TRACKPAD_ZOOM_SENSITIVITY,
  WHEEL_PIXELS_PER_STEP,
  accumulateWheelDelta,
  accumulateWheelSteps,
  accumulateZoomInput,
  classifyOneFingerGesture,
  continuousWheelZoomFactor,
  consumeWheelFrame,
  consumeZoomFrame,
  createWheelZoomState,
  createZoomFrameState,
  normalizeWheelDelta,
  normalizeWheelVector,
  wheelHasPendingDelta,
  zoomFrameHasPending,
} from "../../../../src/editor/zoom";

describe("wheel normalization", () => {
  it("normalizes pixel, line, and page deltas deterministically", () => {
    expect(normalizeWheelDelta(12, 0)).toBe(12);
    expect(normalizeWheelDelta(2, 1)).toBe(2 * DEFAULT_WHEEL_LINE_HEIGHT);
    expect(normalizeWheelDelta(2, 2)).toBe(2 * DEFAULT_WHEEL_PAGE_HEIGHT);
    expect(normalizeWheelDelta(2, 1, { lineHeight: 20 })).toBe(40);
    expect(normalizeWheelDelta(1, 2, { pageHeight: 600 })).toBe(600);
    expect(normalizeWheelVector(2, -3, 1, { lineHeight: 20 })).toEqual({
      x: 40,
      y: -60,
    });
  });

  it("routes one-finger movement with the specified tie boundary", () => {
    expect(classifyOneFingerGesture(12.5, 10)).toBe("horizontal");
    expect(classifyOneFingerGesture(-12.5, 10)).toBe("horizontal");
    expect(classifyOneFingerGesture(12.49, 10)).toBe("vertical");
  });

  it("turns small trackpad pixel deltas into continuous zoom factors", () => {
    expect(TRACKPAD_ZOOM_DELTA_LIMIT).toBe(16);
    expect(TRACKPAD_ZOOM_SENSITIVITY).toBe(2.5);
    expect(TRACKPAD_ZOOM_PIXELS_PER_STEP).toBe(6.4);
    expect(continuousWheelZoomFactor(-4)).toBeCloseTo(1.08 ** 0.625);
    expect(continuousWheelZoomFactor(4)).toBeCloseTo(1.08 ** -0.625);
    expect(continuousWheelZoomFactor(-TRACKPAD_ZOOM_PIXELS_PER_STEP)).toBeCloseTo(1.08);
    expect(continuousWheelZoomFactor(-50, { pixelsPerStep: 50 })).toBeCloseTo(1.08);
  });
});

describe("pure wheel accumulation", () => {
  it("emits exact signed steps without mutating the input state", () => {
    const initial = createWheelZoomState();
    const pending = accumulateWheelDelta(initial, -WHEEL_PIXELS_PER_STEP, 0);
    const consumed = consumeWheelFrame(pending);
    expect(initial).toEqual({ pendingSteps: 0 });
    expect(consumed.frame).toEqual({ steps: 1, factor: 1.08, remainder: 0 });

    const zoomOut = consumeWheelFrame(
      accumulateWheelDelta(consumed.state, WHEEL_PIXELS_PER_STEP, 0),
    );
    expect(zoomOut.frame.factor).toBeCloseTo(1 / 1.08);
  });

  it("retains fractional deltas until they complete a step", () => {
    const quarter = accumulateWheelDelta(createWheelZoomState(), -25, 0);
    expect(wheelHasPendingDelta(quarter)).toBe(true);
    expect(consumeWheelFrame(quarter).frame.factor).toBe(1);
    const whole = accumulateWheelDelta(quarter, -75, 0);
    expect(consumeWheelFrame(whole).frame).toEqual({
      steps: 1,
      factor: 1.08,
      remainder: 0,
    });
    const customThreshold = accumulateWheelDelta(createWheelZoomState(), -50, 0, {
      pixelsPerStep: 50,
    });
    expect(consumeWheelFrame(customThreshold).frame.steps).toBe(1);
  });

  it("limits each frame and carries excess steps forward", () => {
    const pending = accumulateWheelSteps(createWheelZoomState(), 10);
    const first = consumeWheelFrame(pending, MAX_FRAME_ZOOM_FACTOR);
    expect(first.frame.steps).toBe(3);
    expect(first.frame.factor).toBeCloseTo(1.08 ** 3);
    expect(first.state.pendingSteps).toBe(7);
    expect(consumeWheelFrame(first.state).frame.steps).toBe(3);
  });
});

describe("pure atomic zoom-frame accumulation", () => {
  it("multiplies factors, adds pans, and keeps the latest anchor", () => {
    const initial = createZoomFrameState();
    const first = accumulateZoomInput(initial, {
      factor: 1.1,
      panX: 5,
      panY: -2,
      anchor: { anchorX: 10, anchorViewportY: 20 },
    });
    const pending = accumulateZoomInput(first, {
      factor: 1.2,
      panX: -1,
      panY: 3,
      anchor: { anchorX: 30, anchorViewportY: 40 },
    });
    expect(initial).toEqual({ factor: 1, panX: 0, panY: 0 });
    expect(consumeZoomFrame(pending).frame).toEqual({
      factor: 1.32,
      panX: 4,
      panY: 1,
      anchor: { anchorX: 30, anchorViewportY: 40 },
    });
  });

  it("caps a large factor and carries its anchor with the remainder", () => {
    const pending = accumulateZoomInput(createZoomFrameState(), {
      factor: 2,
      anchor: { anchorX: 12, anchorViewportY: 34 },
    });
    const first = consumeZoomFrame(pending);
    expect(first.frame.factor).toBe(MAX_FRAME_ZOOM_FACTOR);
    expect(zoomFrameHasPending(first.state)).toBe(true);
    const second = consumeZoomFrame(first.state);
    expect(second.frame.factor).toBe(MAX_FRAME_ZOOM_FACTOR);
    expect(second.frame.anchor).toEqual({ anchorX: 12, anchorViewportY: 34 });
  });

  it("clears consumed pan and anchor state", () => {
    const pending = accumulateZoomInput(createZoomFrameState(), {
      panX: 4,
      anchor: { anchorX: 1, anchorViewportY: 2 },
    });
    const consumed = consumeZoomFrame(pending);
    expect(consumed.state).toEqual(createZoomFrameState());
    expect(consumeZoomFrame(consumed.state).frame).toEqual({
      factor: 1,
      panX: 0,
      panY: 0,
    });
  });
});
