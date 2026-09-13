import { describe, expect, it } from "vitest";

import {
  EASING_TOKENS,
  MOTION_TOKENS,
  TRANSITION_DURATIONS,
  getMotionDuration,
  getTransitionDuration,
  isReducedMotion,
} from "../../../../src/rendering/motion/transitions";

describe("motion tokens", () => {
  it("exposes the documented duration and easing tokens", () => {
    expect(MOTION_TOKENS).toEqual({
      fast: 120,
      surface: 220,
      standard: 180,
      erase: 160,
      layout: 240,
    });
    expect(EASING_TOKENS.standard).toBe("cubic-bezier(0.2, 0, 0, 1)");
    expect(EASING_TOKENS.emphasized).toBe(EASING_TOKENS.standard);
  });

  it("maps every documented transition to its contract duration", () => {
    expect(TRANSITION_DURATIONS).toEqual({
      adaptiveMenu: 220,
      adaptivePage: 220,
      nativeModalEnterExit: 120,
      toolbarEnterExit: 220,
      toolActiveState: 120,
      selectionHandlesEnterExit: 120,
      eraserPendingRemoval: 160,
      committedEntrance: 120,
      commandRemovalExit: 120,
      styleChange: 120,
      lockedToActiveHeight: 240,
      activeToLockedHeight: 240,
      lockEditorCrossfade: 120,
      automaticPageGrowth: 180,
      overflowEdgeGradient: 120,
      conditionalToolbarControl: 220,
      arrangeResult: 120,
      fallback: 120,
    });
    expect(getTransitionDuration("lockedToActiveHeight")).toBe(240);
  });

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
