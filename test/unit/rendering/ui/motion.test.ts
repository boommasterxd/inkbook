import { describe, expect, it } from "vitest";

import {
  EASING_TOKENS,
  MOTION_TOKENS,
  TRANSITION_DURATIONS,
  advanceTransition,
  createTransition,
  easing,
  finishTransition,
  getMotionDuration,
  getTransitionDuration,
  interruptTransition,
  isReducedMotion,
  motion,
  transitionDurations,
} from "../../../../src/rendering/ui/motion";

const interpolateNumber = (from: number, to: number, progress: number): number =>
  from + (to - from) * progress;

describe("motion tokens", () => {
  it("exposes the documented duration and easing tokens", () => {
    expect(motion).toEqual({
      fast: 120,
      toolbar: 300,
      standard: 180,
      erase: 160,
      layout: 240,
      slow: 300,
    });
    expect(easing.standard).toBe("cubic-bezier(0.2, 0, 0, 1)");
    expect(easing.emphasized).toBe(easing.standard);
    expect(MOTION_TOKENS).toBe(motion);
    expect(EASING_TOKENS).toBe(easing);
  });

  it("maps every documented transition to its contract duration", () => {
    expect(transitionDurations).toEqual({
      toolbarEnterExit: 300,
      toolActiveState: 120,
      flyoutOpenClose: 180,
      selectionHandlesEnterExit: 120,
      eraserPendingRemoval: 160,
      committedEntrance: 120,
      commandRemovalExit: 120,
      backgroundChange: 180,
      styleChange: 120,
      lockedToActiveHeight: 240,
      activeToLockedHeight: 240,
      lockEditorCrossfade: 120,
      automaticPageGrowth: 180,
      overflowEdgeGradient: 120,
      conditionalToolbarControl: 300,
      arrangeResult: 120,
      snapCandidateMarker: 120,
      fallback: 120,
    });
    expect(TRANSITION_DURATIONS).toBe(transitionDurations);
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
    expect(getTransitionDuration("backgroundChange", true)).toBe(0);
  });
});

describe("motion transitions", () => {
  it("starts, advances, and completes a transition without mutating its state", () => {
    const initial = createTransition({
      from: 0,
      to: 100,
      durationMs: 200,
      interpolate: interpolateNumber,
    });

    expect(initial).toMatchObject({
      from: 0,
      to: 100,
      current: 0,
      durationMs: 200,
      elapsedMs: 0,
      progress: 0,
      status: "running",
      easing: "standard",
      reducedMotion: false,
    });

    const halfway = advanceTransition(initial, 100);
    expect(halfway.current).toBe(50);
    expect(halfway.progress).toBe(0.5);
    expect(halfway.status).toBe("running");
    expect(initial.current).toBe(0);

    const complete = advanceTransition(halfway, 200);
    expect(complete.current).toBe(100);
    expect(complete.elapsedMs).toBe(200);
    expect(complete.progress).toBe(1);
    expect(complete.status).toBe("complete");
    expect(advanceTransition(complete, 50)).toBe(complete);
  });

  it("starts reduced-motion transitions at their final target", () => {
    const state = createTransition({
      from: 10,
      to: 20,
      durationMs: 240,
      interpolate: interpolateNumber,
      reducedMotion: true,
    });

    expect(state).toMatchObject({
      from: 10,
      to: 20,
      current: 20,
      durationMs: 0,
      elapsedMs: 0,
      progress: 1,
      status: "complete",
      reducedMotion: true,
    });
  });

  it("retargets from the currently rendered value when interrupted", () => {
    const started = createTransition({
      from: 0,
      to: 100,
      durationMs: 200,
      interpolate: interpolateNumber,
    });
    const rendered = advanceTransition(started, 70);
    const interrupted = interruptTransition(rendered, 200);

    expect(rendered.current).toBe(35);
    expect(interrupted.from).toBe(35);
    expect(interrupted.current).toBe(35);
    expect(interrupted.to).toBe(200);
    expect(interrupted.durationMs).toBe(200);
    expect(advanceTransition(interrupted, 100).current).toBe(117.5);
  });
});

describe("motion handoff", () => {
  it("supports immediate completion before a new input gesture", () => {
    const state = createTransition({
      from: 0,
      to: 100,
      durationMs: 240,
      interpolate: interpolateNumber,
    });
    const finished = finishTransition(advanceTransition(state, 30));

    expect(finished.current).toBe(100);
    expect(finished.status).toBe("complete");
    expect(finished.elapsedMs).toBe(240);
    expect(finishTransition(finished)).toBe(finished);
  });

  it("rejects invalid durations and elapsed deltas", () => {
    expect(() => getMotionDuration(-1, false)).toThrow(RangeError);
    expect(() => getMotionDuration(Number.NaN, false)).toThrow(RangeError);
    expect(() =>
      createTransition({ from: 0, to: 1, durationMs: -1, interpolate: interpolateNumber }),
    ).toThrow(RangeError);

    const state = createTransition({
      from: 0,
      to: 1,
      durationMs: 100,
      interpolate: interpolateNumber,
    });
    expect(() => advanceTransition(state, -1)).toThrow(RangeError);
    expect(() => advanceTransition(state, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
