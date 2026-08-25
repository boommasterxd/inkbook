import type { InputAwareSliceScheduler, RuntimeSliceWorkProfile } from "./types";

export interface SliceSchedulerOptions {
  readonly isInputActive: () => boolean;
  readonly now?: () => number;
  readonly profile?: "desktop" | "mobile";
  readonly sliceMilliseconds?: number | (() => number);
  readonly yieldControl: () => Promise<void>;
}

const DESKTOP_SLICE_MS = 6;
const MOBILE_SLICE_MS = 10;

const DEFAULT_WORK_PROFILE: RuntimeSliceWorkProfile = Object.freeze({
  inputByteLimit: 16 * 1024,
  nodeLimit: 256,
  outputByteLimit: 64 * 1024,
});

export function runtimeSliceWorkProfile(
  sliceMilliseconds: number | undefined,
): RuntimeSliceWorkProfile {
  if (
    sliceMilliseconds === undefined ||
    !Number.isFinite(sliceMilliseconds) ||
    sliceMilliseconds <= 0
  ) {
    return DEFAULT_WORK_PROFILE;
  }
  if (sliceMilliseconds <= 2.75) {
    return { inputByteLimit: 4 * 1024, nodeLimit: 64, outputByteLimit: 16 * 1024 };
  }
  if (sliceMilliseconds <= 4.25) {
    return { inputByteLimit: 6 * 1024, nodeLimit: 96, outputByteLimit: 24 * 1024 };
  }
  if (sliceMilliseconds <= 5.5) {
    return { inputByteLimit: 8 * 1024, nodeLimit: 128, outputByteLimit: 32 * 1024 };
  }
  if (sliceMilliseconds <= 7) {
    return { inputByteLimit: 12 * 1024, nodeLimit: 192, outputByteLimit: 48 * 1024 };
  }
  return DEFAULT_WORK_PROFILE;
}

export class GestureAwareSliceScheduler implements InputAwareSliceScheduler {
  readonly #isInputActive: () => boolean;
  readonly #now: () => number;
  readonly #sliceMilliseconds: () => number;
  readonly #yieldControl: () => Promise<void>;
  #liveInputActive = false;
  #sliceStarted: number;

  public constructor(options: SliceSchedulerOptions) {
    this.#isInputActive = options.isInputActive;
    this.#now = options.now ?? (() => performance.now());
    const configured =
      options.sliceMilliseconds ??
      (options.profile === "mobile" ? MOBILE_SLICE_MS : DESKTOP_SLICE_MS);
    this.#sliceMilliseconds = typeof configured === "function" ? configured : () => configured;
    validateSliceMilliseconds(this.#sliceMilliseconds());
    this.#yieldControl = options.yieldControl;
    this.#sliceStarted = this.#now();
  }

  public setLiveInputActive(active: boolean): void {
    this.#liveInputActive = active;
  }

  public getSliceMilliseconds(): number {
    return validateSliceMilliseconds(this.#sliceMilliseconds());
  }

  public getSliceWorkProfile(): RuntimeSliceWorkProfile {
    return runtimeSliceWorkProfile(this.getSliceMilliseconds());
  }

  public async checkpoint(signal: AbortSignal): Promise<void> {
    while (this.#inputActive()) {
      signal.throwIfAborted();
      await this.#yieldControl();
      this.#sliceStarted = this.#now();
    }
    signal.throwIfAborted();
    if (this.#now() - this.#sliceStarted < this.getSliceMilliseconds()) {
      return;
    }
    await this.#yieldControl();
    this.#sliceStarted = this.#now();
    signal.throwIfAborted();
  }

  public async run<T>(
    operation: (signal: AbortSignal) => T | Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    while (this.#inputActive()) await this.checkpoint(signal);
    this.#sliceStarted = this.#now();
    return operation(signal);
  }

  #inputActive(): boolean {
    return this.#liveInputActive || this.#isInputActive();
  }
}

function validateSliceMilliseconds(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new RangeError("sliceMilliseconds must be a positive finite number.");
  }
  return value;
}
