import type { RefreshRatePreferenceV2 } from "../../domain/settings";

import {
  conservativeRefreshRate,
  DEFAULT_REFRESH_RATE,
  fixedRefreshRate,
  refreshRateProfile,
  type FixedRefreshRate,
  type RefreshRateProfile,
} from "./refresh-rate-profile";

const REQUIRED_INTERVALS = 18;
const MAXIMUM_SAMPLE_FRAMES = 48;
const MINIMUM_INTERVAL_MS = 2;
const MAXIMUM_INTERVAL_MS = 50;

interface WindowRefreshState {
  readonly ownerDocument: Document;
  detectedRate: FixedRefreshRate | undefined;
  intervals: number[];
  lastTimestamp: number | undefined;
  sampleFrames: number;
  references: number;
  frame: number | undefined;
  readonly visibilityChanged: () => void;
}

export type RefreshRateProfileStatus =
  | { readonly kind: "detected"; readonly refreshRate: FixedRefreshRate }
  | { readonly kind: "detecting"; readonly refreshRate: typeof DEFAULT_REFRESH_RATE }
  | { readonly kind: "fixed"; readonly refreshRate: FixedRefreshRate };

export class WindowRefreshRateProfiles {
  readonly #states = new Map<Window, WindowRefreshState>();
  #detectedRates = new WeakMap<Window, FixedRefreshRate>();
  #preference: RefreshRatePreferenceV2;
  readonly #profileChanged: (ownerWindow: Window) => void;

  public constructor(
    preference: RefreshRatePreferenceV2,
    profileChanged: (ownerWindow: Window) => void = () => undefined,
  ) {
    this.#preference = preference;
    this.#profileChanged = profileChanged;
  }

  public acquire(ownerWindow: Window, ownerDocument: Document): () => void {
    let state = this.#states.get(ownerWindow);
    if (state === undefined) {
      state = this.#createState(ownerWindow, ownerDocument);
      this.#states.set(ownerWindow, state);
    }
    state.references += 1;
    if (this.#preference === "auto") this.#start(ownerWindow, state);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.references -= 1;
      if (state.references > 0) return;
      this.#removeState(ownerWindow, state);
    };
  }

  public profile(ownerWindow: Window): RefreshRateProfile {
    const fixed = fixedRefreshRate(this.#preference);
    if (fixed !== undefined) return refreshRateProfile(fixed);
    const detected =
      this.#states.get(ownerWindow)?.detectedRate ??
      this.#detectedRates.get(ownerWindow) ??
      DEFAULT_REFRESH_RATE;
    return refreshRateProfile(detected);
  }

  public status(ownerWindow: Window | undefined): RefreshRateProfileStatus {
    const fixed = fixedRefreshRate(this.#preference);
    if (fixed !== undefined) return { kind: "fixed", refreshRate: fixed };
    const detected =
      ownerWindow === undefined
        ? undefined
        : (this.#states.get(ownerWindow)?.detectedRate ?? this.#detectedRates.get(ownerWindow));
    return detected === undefined
      ? { kind: "detecting", refreshRate: DEFAULT_REFRESH_RATE }
      : { kind: "detected", refreshRate: detected };
  }

  public setPreference(preference: RefreshRatePreferenceV2): void {
    if (preference === this.#preference) return;
    this.#preference = preference;
    this.#detectedRates = new WeakMap();
    for (const [ownerWindow, state] of this.#states) {
      this.#cancel(ownerWindow, state);
      state.detectedRate = undefined;
      if (preference === "auto") this.#start(ownerWindow, state);
      this.#profileChanged(ownerWindow);
    }
  }

  public dispose(): void {
    for (const [ownerWindow, state] of this.#states) this.#removeState(ownerWindow, state);
    this.#states.clear();
    this.#detectedRates = new WeakMap();
  }

  #createState(ownerWindow: Window, ownerDocument: Document): WindowRefreshState {
    const state: WindowRefreshState = {
      ownerDocument,
      detectedRate: this.#detectedRates.get(ownerWindow),
      intervals: [],
      lastTimestamp: undefined,
      sampleFrames: 0,
      references: 0,
      frame: undefined,
      visibilityChanged: () => this.#visibilityChanged(ownerWindow, state),
    };
    ownerDocument.addEventListener?.("visibilitychange", state.visibilityChanged);
    return state;
  }

  #visibilityChanged(ownerWindow: Window, state: WindowRefreshState): void {
    if (state.ownerDocument.visibilityState === "hidden") {
      this.#cancel(ownerWindow, state);
      return;
    }
    if (this.#preference !== "auto" || state.references === 0 || state.detectedRate !== undefined) {
      return;
    }
    this.#start(ownerWindow, state);
  }

  #start(ownerWindow: Window, state: WindowRefreshState): void {
    if (
      state.detectedRate !== undefined ||
      state.frame !== undefined ||
      state.ownerDocument.visibilityState === "hidden"
    ) {
      return;
    }
    state.intervals = [];
    state.lastTimestamp = undefined;
    state.sampleFrames = 0;
    const requestNext = (): void => {
      const frame = ownerWindow.requestAnimationFrame(sample);
      if (state.detectedRate === undefined) state.frame = frame;
    };
    const sample = (timestamp: number): void => {
      if (this.#preference !== "auto" || state.references === 0) return;
      state.frame = undefined;
      state.sampleFrames += 1;
      if (state.lastTimestamp !== undefined) {
        const interval = timestamp - state.lastTimestamp;
        if (interval >= MINIMUM_INTERVAL_MS && interval <= MAXIMUM_INTERVAL_MS) {
          state.intervals.push(interval);
        }
      }
      state.lastTimestamp = timestamp;
      if (
        state.intervals.length >= REQUIRED_INTERVALS ||
        state.sampleFrames >= MAXIMUM_SAMPLE_FRAMES
      ) {
        state.detectedRate = detectRefreshRate(state.intervals);
        this.#detectedRates.set(ownerWindow, state.detectedRate);
        this.#profileChanged(ownerWindow);
        return;
      }
      requestNext();
    };
    requestNext();
  }

  #cancel(ownerWindow: Window, state: WindowRefreshState): void {
    if (state.frame !== undefined) ownerWindow.cancelAnimationFrame(state.frame);
    state.frame = undefined;
    state.intervals = [];
    state.lastTimestamp = undefined;
    state.sampleFrames = 0;
  }

  #removeState(ownerWindow: Window, state: WindowRefreshState): void {
    this.#cancel(ownerWindow, state);
    state.ownerDocument.removeEventListener?.("visibilitychange", state.visibilityChanged);
    this.#states.delete(ownerWindow);
  }
}

export function detectRefreshRate(intervals: readonly number[]): FixedRefreshRate {
  const valid = intervals
    .filter(
      (interval) =>
        Number.isFinite(interval) &&
        interval >= MINIMUM_INTERVAL_MS &&
        interval <= MAXIMUM_INTERVAL_MS,
    )
    .sort((left, right) => left - right);
  if (valid.length === 0) return DEFAULT_REFRESH_RATE;
  const representative = valid[Math.floor((valid.length - 1) * 0.25)] ?? valid[0] ?? 0;
  return conservativeRefreshRate(1_000 / representative);
}
