import { describe, expect, it } from "vitest";

import {
  accumulateContinuousZoomInput,
  horizontalPanWheel,
} from "../../../../../src/obsidian/embeds/active-editor/navigation-helpers";

describe("horizontal wheel routing", () => {
  it("accepts strict horizontal dominance including inertial diagonal tails", () => {
    expect(horizontalPanWheel(wheel({ deltaX: 20, deltaY: 18 }), {})).toBe(-20);
    expect(horizontalPanWheel(wheel({ deltaX: -20, deltaY: -18 }), {})).toBe(20);
    expect(horizontalPanWheel(wheel({ deltaX: 18, deltaY: 20 }), {})).toBeUndefined();
    expect(horizontalPanWheel(wheel({ deltaX: 20, deltaY: 20 }), {})).toBeUndefined();
  });

  it("maps only a pure Shift-wheel vertical delta to horizontal movement", () => {
    expect(horizontalPanWheel(wheel({ deltaX: 0, deltaY: 2, shiftKey: true }), {})).toBe(-2);
    expect(horizontalPanWheel(wheel({ deltaX: 1, deltaY: 2, shiftKey: true }), {})).toBeUndefined();
  });
});

function wheel(overrides: {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly shiftKey?: boolean;
}) {
  return {
    clientX: 0,
    clientY: 0,
    deltaMode: 0,
    ...overrides,
  };
}

describe("bounded continuous zoom backlog", () => {
  const state = { factor: 1, panX: 3, panY: 4 };
  it("caps extreme factors at the actual fit and maximum camera limits", () => {
    expect(accumulateContinuousZoomInput(state, { factor: Number.MAX_VALUE }, 1, 0.5)).toEqual({
      ...state,
      factor: 5,
    });
    expect(accumulateContinuousZoomInput(state, { factor: Number.MIN_VALUE }, 1, 0.5)).toEqual({
      ...state,
      factor: 0.5,
    });
    expect(accumulateContinuousZoomInput(state, { factor: 4 }, 10, 2).factor).toBe(1);
    expect(accumulateContinuousZoomInput(state, { factor: 0.25 }, 0.5, 0.5).factor).toBe(1);
  });

  it("drops opposite pending scale while preserving pan and the newest anchor", () => {
    const anchor = { anchorX: 20, anchorViewportY: 30 };
    const next = accumulateContinuousZoomInput(
      { ...state, factor: 5 },
      { factor: 0.9, anchor },
      2,
      0.5,
    );
    expect(next).toEqual({ ...state, factor: 0.9, anchor });
    expect(
      accumulateContinuousZoomInput({ ...state, factor: 0.5 }, { factor: 1.1 }, 2, 0.5).factor,
    ).toBe(1.1);
    expect(accumulateContinuousZoomInput({ ...state, factor: 1.1 }, {}, 2, 0.5).factor).toBe(1.1);
    expect(() => accumulateContinuousZoomInput(state, { factor: 0 }, 1, 0.5)).toThrow();
    expect(() => accumulateContinuousZoomInput(state, {}, 0, 0.5)).toThrow();
  });
});
