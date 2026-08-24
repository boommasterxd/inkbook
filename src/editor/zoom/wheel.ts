import {
  MAX_FRAME_ZOOM_FACTOR,
  ZOOM_STEP_FACTOR,
  clampFrameZoomFactor,
  zoomFactorForSteps,
} from "./zoom";
import { requireFinite, requirePositive } from "./numeric-validation";

export const DEFAULT_WHEEL_LINE_HEIGHT = 16;
export const DEFAULT_WHEEL_PAGE_HEIGHT = 800;
export const TRACKPAD_ZOOM_DELTA_LIMIT = 16;
export const TRACKPAD_ZOOM_SENSITIVITY = 2.5;
export const TRACKPAD_ZOOM_PIXELS_PER_STEP = TRACKPAD_ZOOM_DELTA_LIMIT / TRACKPAD_ZOOM_SENSITIVITY;
export const WHEEL_PIXELS_PER_STEP = 100;

export type WheelDeltaMode = 0 | 1 | 2;

export interface WheelNormalization {
  readonly lineHeight?: number;
  readonly pageHeight?: number;
  /** Optional calibration override for a specific input adapter or deterministic test. */
  readonly pixelsPerStep?: number;
}

export interface WheelVector {
  readonly x: number;
  readonly y: number;
}

export interface WheelZoomState {
  readonly pendingSteps: number;
}

interface WheelFrame {
  readonly steps: number;
  readonly factor: number;
  readonly remainder: number;
}

export interface WheelFrameReduction {
  readonly state: WheelZoomState;
  readonly frame: WheelFrame;
}

export interface ZoomInputEvent {
  readonly factor?: number;
  readonly panX?: number;
  readonly panY?: number;
  readonly anchor?: { readonly anchorX: number; readonly anchorViewportY: number };
}

interface ZoomInputFrame {
  readonly factor: number;
  readonly panX: number;
  readonly panY: number;
  readonly anchor?: { readonly anchorX: number; readonly anchorViewportY: number };
}

export type ZoomFrameState = ZoomInputFrame;

export interface ZoomFrameReduction {
  readonly state: ZoomFrameState;
  readonly frame: ZoomInputFrame;
}

export function normalizeWheelDelta(
  delta: number,
  deltaMode: WheelDeltaMode,
  options: WheelNormalization = {},
): number {
  requireFinite(delta, "delta");
  const lineHeight = requirePositive(options.lineHeight ?? DEFAULT_WHEEL_LINE_HEIGHT, "lineHeight");
  const pageHeight = requirePositive(options.pageHeight ?? DEFAULT_WHEEL_PAGE_HEIGHT, "pageHeight");
  switch (deltaMode) {
    case 0:
      return delta;
    case 1:
      return delta * lineHeight;
    case 2:
      return delta * pageHeight;
  }
}

/** Normalizes both wheel axes to screen-pixel-equivalent deltas. */
export function normalizeWheelVector(
  deltaX: number,
  deltaY: number,
  deltaMode: WheelDeltaMode,
  options: WheelNormalization = {},
): WheelVector {
  return {
    x: normalizeWheelDelta(deltaX, deltaMode, options),
    y: normalizeWheelDelta(deltaY, deltaMode, options),
  };
}

export function classifyOneFingerGesture(
  deltaX: number,
  deltaY: number,
): "horizontal" | "vertical" {
  requireFinite(deltaX, "deltaX");
  requireFinite(deltaY, "deltaY");
  return Math.abs(deltaX) >= 1.25 * Math.abs(deltaY) ? "horizontal" : "vertical";
}

export function createWheelZoomState(): WheelZoomState {
  return { pendingSteps: 0 };
}

export function accumulateWheelDelta(
  state: WheelZoomState,
  delta: number,
  deltaMode: WheelDeltaMode,
  options: WheelNormalization = {},
): WheelZoomState {
  const normalizedDelta = normalizeWheelDelta(delta, deltaMode, options);
  const pixelsPerStep = requirePositive(
    options.pixelsPerStep ?? WHEEL_PIXELS_PER_STEP,
    "pixelsPerStep",
  );
  return accumulateWheelSteps(state, -normalizedDelta / pixelsPerStep);
}

/** Converts a pixel-based modifier-wheel delta into a continuous trackpad zoom factor. */
export function continuousWheelZoomFactor(delta: number, options: WheelNormalization = {}): number {
  const normalizedDelta = normalizeWheelDelta(delta, 0, options);
  const pixelsPerStep = requirePositive(
    options.pixelsPerStep ?? TRACKPAD_ZOOM_PIXELS_PER_STEP,
    "pixelsPerStep",
  );
  return requirePositive(ZOOM_STEP_FACTOR ** (-normalizedDelta / pixelsPerStep), "zoomFactor");
}

export function accumulateWheelSteps(state: WheelZoomState, steps: number): WheelZoomState {
  requireFinite(steps, "steps");
  return { pendingSteps: requireFinite(state.pendingSteps + steps, "pendingSteps") };
}

export function wheelHasPendingDelta(state: WheelZoomState): boolean {
  return state.pendingSteps !== 0;
}

export function consumeWheelFrame(
  state: WheelZoomState,
  maxFactor = MAX_FRAME_ZOOM_FACTOR,
): WheelFrameReduction {
  requirePositive(maxFactor, "maxFactor");
  if (maxFactor < ZOOM_STEP_FACTOR) {
    throw new RangeError("maxFactor must allow at least one zoom step");
  }
  const maxWholeSteps = Math.floor(Math.log(maxFactor) / Math.log(ZOOM_STEP_FACTOR));
  const wholeSteps = Math.trunc(state.pendingSteps);
  const steps = Math.sign(wholeSteps) * Math.min(Math.abs(wholeSteps), maxWholeSteps);
  const remainder = state.pendingSteps - steps;
  return {
    state: { pendingSteps: remainder },
    frame: { steps, factor: zoomFactorForSteps(steps), remainder },
  };
}

export function createZoomFrameState(): ZoomFrameState {
  return { factor: 1, panX: 0, panY: 0 };
}

export function accumulateZoomInput(state: ZoomFrameState, input: ZoomInputEvent): ZoomFrameState {
  const factor = requirePositive(input.factor ?? 1, "factor");
  const panX = requireFinite(input.panX ?? 0, "panX");
  const panY = requireFinite(input.panY ?? 0, "panY");
  if (input.anchor !== undefined) {
    requireFinite(input.anchor.anchorX, "anchor.anchorX");
    requireFinite(input.anchor.anchorViewportY, "anchor.anchorViewportY");
  }
  return {
    factor: requirePositive(state.factor * factor, "pendingFactor"),
    panX: requireFinite(state.panX + panX, "pendingPanX"),
    panY: requireFinite(state.panY + panY, "pendingPanY"),
    ...(input.anchor === undefined && state.anchor === undefined
      ? {}
      : { anchor: input.anchor ?? state.anchor }),
  };
}

export function zoomFrameHasPending(state: ZoomFrameState): boolean {
  return state.factor !== 1 || state.panX !== 0 || state.panY !== 0;
}

export function consumeZoomFrame(
  state: ZoomFrameState,
  maxFactor = MAX_FRAME_ZOOM_FACTOR,
): ZoomFrameReduction {
  const factor = clampFrameZoomFactor(state.factor, maxFactor);
  const remainingFactor = state.factor / factor;
  const frame: ZoomInputFrame = {
    factor,
    panX: state.panX,
    panY: state.panY,
    ...(state.anchor === undefined ? {} : { anchor: state.anchor }),
  };
  const nextState: ZoomFrameState = {
    factor: remainingFactor,
    panX: 0,
    panY: 0,
    ...(remainingFactor === 1 || state.anchor === undefined ? {} : { anchor: state.anchor }),
  };
  return { state: nextState, frame };
}
