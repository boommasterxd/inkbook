/**
 * Shared motion values for editor chrome and imperative scene transitions.
 *
 * The module is deliberately independent of DOM and UI frameworks. Callers
 * decide how to apply the selected duration, while this module keeps timing
 * and interruption semantics consistent across rendering surfaces.
 */

export const MOTION_TOKENS = Object.freeze({
  fast: 120,
  surface: 220,
  standard: 180,
  erase: 400,
  layout: 240,
} as const);

export const EASING_TOKENS = Object.freeze({
  erase: "cubic-bezier(0.645, 0.045, 0.355, 1)",
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  emphasized: "cubic-bezier(0.2, 0, 0, 1)",
} as const);

export const TRANSITION_DURATIONS = Object.freeze({
  adaptiveMenu: MOTION_TOKENS.surface,
  adaptivePage: MOTION_TOKENS.surface,
  nativeModalEnterExit: MOTION_TOKENS.fast,
  toolbarEnterExit: MOTION_TOKENS.surface,
  toolActiveState: MOTION_TOKENS.fast,
  selectionHandlesEnterExit: MOTION_TOKENS.fast,
  eraserPendingRemoval: MOTION_TOKENS.erase,
  historyMembership: MOTION_TOKENS.erase,
  committedEntrance: MOTION_TOKENS.fast,
  commandRemovalExit: MOTION_TOKENS.fast,
  styleChange: MOTION_TOKENS.fast,
  lockedToActiveHeight: MOTION_TOKENS.layout,
  activeToLockedHeight: MOTION_TOKENS.layout,
  lockEditorCrossfade: MOTION_TOKENS.fast,
  automaticPageGrowth: MOTION_TOKENS.standard,
  overflowEdgeGradient: MOTION_TOKENS.fast,
  conditionalToolbarControl: MOTION_TOKENS.surface,
  arrangeResult: MOTION_TOKENS.fast,
  fallback: MOTION_TOKENS.fast,
} as const);

export type MotionPreference = "system" | "full" | "reduced";
export type TransitionName = keyof typeof TRANSITION_DURATIONS;

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

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}
