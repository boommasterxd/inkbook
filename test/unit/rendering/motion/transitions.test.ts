import { describe, expect, it } from "vitest";

import {
  getMotionDuration,
  getTransitionDuration,
  isReducedMotion,
} from "../../../../src/rendering/motion/transitions";

describe("motion tokens", () => {
  it("resolves explicit and system reduced-motion preferences", () => {
    expect(isReducedMotion("reduced", false)).toBe(true);
    expect(isReducedMotion("reduced", true)).toBe(true);
    expect(isReducedMotion("full", false)).toBe(false);
    expect(isReducedMotion("full", true)).toBe(false);
    expect(isReducedMotion("system", false)).toBe(false);
    expect(isReducedMotion("system", true)).toBe(true);
    expect(getMotionDuration(180, false)).toBe(180);
    expect(getMotionDuration(180, true)).toBe(0);
    expect(getTransitionDuration("styleChange", true)).toBe(0);
  });
});
