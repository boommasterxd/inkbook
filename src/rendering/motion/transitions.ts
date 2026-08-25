/**
 * Shared motion values for editor chrome and imperative scene transitions.
 *
 * The module is deliberately independent of DOM and UI frameworks. Callers
 * decide how to apply the selected duration, while this module keeps timing
 * and interruption semantics consistent across rendering surfaces.
 */

export const MOTION_TOKENS = Object.freeze({
  fast: 120,
  toolbar: 300,
  standard: 180,
  erase: 160,
  layout: 240,
  slow: 300,
} as const);

export const EASING_TOKENS = Object.freeze({
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  emphasized: "cubic-bezier(0.2, 0, 0, 1)",
} as const);

export const TRANSITION_DURATIONS = Object.freeze({
  toolbarEnterExit: MOTION_TOKENS.toolbar,
  toolActiveState: MOTION_TOKENS.fast,
  flyoutOpenClose: MOTION_TOKENS.standard,
  selectionHandlesEnterExit: MOTION_TOKENS.fast,
  eraserPendingRemoval: MOTION_TOKENS.erase,
  committedEntrance: MOTION_TOKENS.fast,
  commandRemovalExit: MOTION_TOKENS.fast,
  backgroundChange: MOTION_TOKENS.standard,
  styleChange: MOTION_TOKENS.fast,
  lockedToActiveHeight: MOTION_TOKENS.layout,
  activeToLockedHeight: MOTION_TOKENS.layout,
  lockEditorCrossfade: MOTION_TOKENS.fast,
  automaticPageGrowth: MOTION_TOKENS.standard,
  overflowEdgeGradient: MOTION_TOKENS.fast,
  conditionalToolbarControl: MOTION_TOKENS.toolbar,
  arrangeResult: MOTION_TOKENS.fast,
  snapCandidateMarker: MOTION_TOKENS.fast,
  fallback: MOTION_TOKENS.fast,
} as const);

export type MotionPreference = "system" | "full" | "reduced";
export type TransitionName = keyof typeof TRANSITION_DURATIONS;
type EasingName = keyof typeof EASING_TOKENS;
type TransitionStatus = "running" | "complete";

/** Resolve a persisted motion preference against the host's system setting. */
export function isReducedMotion(
  preference: MotionPreference,
  systemReducedMotion = false,
): boolean {
  if (preference === "reduced") {
    return true;
  }

  if (preference === "full") {
    return false;
  }

  return systemReducedMotion;
}

/** Select the effective duration, applying reduced motion to non-essential work. */
export function getMotionDuration(durationMs: number, reducedMotion = false): number {
  assertNonNegativeFinite(durationMs, "durationMs");
  return reducedMotion ? 0 : durationMs;
}

export function getTransitionDuration(transition: TransitionName, reducedMotion = false): number {
  return getMotionDuration(TRANSITION_DURATIONS[transition], reducedMotion);
}

type MotionInterpolator<T> = (from: T, to: T, progress: number) => T;

export interface TransitionOptions<T> {
  readonly from: T;
  readonly to: T;
  readonly durationMs: number;
  readonly interpolate: MotionInterpolator<T>;
  readonly easing?: EasingName;
  readonly reducedMotion?: boolean;
}

export interface MotionTransitionState<T> {
  readonly from: T;
  readonly to: T;
  readonly current: T;
  readonly durationMs: number;
  readonly elapsedMs: number;
  readonly progress: number;
  readonly status: TransitionStatus;
  readonly easing: EasingName;
  readonly reducedMotion: boolean;
  readonly interpolate: MotionInterpolator<T>;
}

/** Start a transition. Reduced motion adopts the target in the first frame. */
export function createTransition<T>(options: TransitionOptions<T>): MotionTransitionState<T> {
  const reducedMotion = options.reducedMotion ?? false;
  const durationMs = getMotionDuration(options.durationMs, reducedMotion);
  const complete = durationMs === 0;

  return freezeState({
    from: options.from,
    to: options.to,
    current: complete ? options.to : options.from,
    durationMs,
    elapsedMs: 0,
    progress: complete ? 1 : 0,
    status: complete ? "complete" : "running",
    easing: options.easing ?? "standard",
    reducedMotion,
    interpolate: options.interpolate,
  });
}

/** Advance a transition by a duration delta and return the new immutable state. */
export function advanceTransition<T>(
  state: MotionTransitionState<T>,
  deltaMs: number,
): MotionTransitionState<T> {
  assertNonNegativeFinite(deltaMs, "deltaMs");
  if (state.status === "complete") {
    return state;
  }

  const elapsedMs = Math.min(state.durationMs, state.elapsedMs + deltaMs);
  const progress = state.durationMs === 0 ? 1 : elapsedMs / state.durationMs;
  const complete = progress >= 1;

  return freezeState({
    ...state,
    current: state.interpolate(state.from, state.to, progress),
    elapsedMs,
    progress,
    status: complete ? "complete" : "running",
  });
}

export interface InterruptOptions<T> {
  readonly durationMs?: number;
  readonly easing?: EasingName;
  readonly reducedMotion?: boolean;
  readonly interpolate?: MotionInterpolator<T>;
}

/**
 * Retarget a transition from its currently rendered value.
 *
 * The caller must advance the state for the current frame before invoking
 * this function. The returned state's `from` is exactly that rendered value,
 * so a new target never jumps back to the original transition start.
 */
export function interruptTransition<T>(
  state: MotionTransitionState<T>,
  to: T,
  options: InterruptOptions<T> = {},
): MotionTransitionState<T> {
  return createTransition({
    from: state.current,
    to,
    durationMs: options.durationMs ?? state.durationMs,
    interpolate: options.interpolate ?? state.interpolate,
    easing: options.easing ?? state.easing,
    reducedMotion: options.reducedMotion ?? state.reducedMotion,
  });
}

/** Immediately materialize the target, for input, focus, or recovery handoff. */
export function finishTransition<T>(state: MotionTransitionState<T>): MotionTransitionState<T> {
  if (state.status === "complete") {
    return state;
  }

  return freezeState({
    ...state,
    current: state.to,
    elapsedMs: state.durationMs,
    progress: 1,
    status: "complete",
  });
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

function freezeState<T>(state: MotionTransitionState<T>): MotionTransitionState<T> {
  return Object.freeze(state);
}
