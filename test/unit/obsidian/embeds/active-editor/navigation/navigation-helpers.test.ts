import { describe, expect, it } from "vitest";

import { horizontalPanWheel } from "../../../../../../src/obsidian/embeds/active-editor/navigation/navigation-helpers";

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
