import { describe, expect, it } from "vitest";

import {
  accumulateZoomInput,
  continuousWheelZoomFactor,
  consumeZoomFrame,
  createZoomFrameState,
  normalizeWheelVector,
  zoomFrameHasPending,
} from "../../../../src/editor/zoom";
import {
  DEFAULT_WHEEL_LINE_HEIGHT,
  DEFAULT_WHEEL_PAGE_HEIGHT,
  TRACKPAD_ZOOM_PIXELS_PER_STEP,
  normalizeWheelDelta,
} from "../../../../src/editor/zoom/wheel";
import { MAX_FRAME_ZOOM_FACTOR } from "../../../../src/editor/zoom/zoom";

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

  it("turns pixel deltas into continuous zoom factors", () => {
    expect(TRACKPAD_ZOOM_PIXELS_PER_STEP).toBeCloseTo(100 * Math.log(1.08));
    expect(continuousWheelZoomFactor(-4)).toBeCloseTo(Math.exp(0.04));
    expect(continuousWheelZoomFactor(4)).toBeCloseTo(Math.exp(-0.04));
    expect(continuousWheelZoomFactor(-TRACKPAD_ZOOM_PIXELS_PER_STEP)).toBeCloseTo(1.08);
    expect(continuousWheelZoomFactor(-50, { pixelsPerStep: 50 })).toBeCloseTo(1.08);
  });
});

describe("extreme finite pixel zoom input", () => {
  it.each([-Number.MAX_VALUE, Number.MAX_VALUE])(
    "keeps delta %s finite and composable",
    (delta) => {
      const factor = continuousWheelZoomFactor(delta);
      expect(Number.isFinite(factor)).toBe(true);
      expect(factor).toBeGreaterThan(0);
      const first = accumulateZoomInput(createZoomFrameState(), { factor });
      const second = accumulateZoomInput(first, { factor });
      expect(Number.isFinite(second.factor)).toBe(true);
      expect(second.factor).toBeGreaterThan(0);
      const frame = consumeZoomFrame(second);
      expect(Number.isFinite(frame.state.factor)).toBe(true);
      expect(frame.frame.factor).toBeGreaterThanOrEqual(1 / MAX_FRAME_ZOOM_FACTOR);
      expect(frame.frame.factor).toBeLessThanOrEqual(MAX_FRAME_ZOOM_FACTOR);
    },
  );

  it("keeps reciprocal inputs and same-direction partitions consistent", () => {
    for (const delta of [0.1, 15.9, 16, 16.1, 64, 1000]) {
      const whole = continuousWheelZoomFactor(delta);
      const partial = continuousWheelZoomFactor(delta / 4);
      expect(partial ** 4).toBeCloseTo(whole, 12);
      expect(whole * continuousWheelZoomFactor(-delta)).toBeCloseTo(1, 12);
    }
    expect(() => continuousWheelZoomFactor(Infinity)).toThrow();
    expect(() => continuousWheelZoomFactor(Number.NaN)).toThrow();
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
