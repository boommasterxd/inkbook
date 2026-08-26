import { HorizontalPanMomentum } from "../../../editor/zoom/index";

export const TRACKPAD_PAN_DEFAULT_IDLE_MS = 24;
export const TRACKPAD_PAN_MAX_IDLE_MS = 40;
export const TRACKPAD_PAN_MIN_IDLE_MS = 8;
const TRACKPAD_PAN_IDLE_INTERVAL_FACTOR = 1.5;
const TRACKPAD_PAN_MAX_SAMPLE_INTERVAL_MS = 100;

interface TrackpadPanClock {
  readonly performance: Pick<Performance, "now">;
}

export interface TrackpadPanInput {
  readonly deltaMode: number;
  readonly shiftKey: boolean;
}

export function isTrackpadPanInput(input: TrackpadPanInput): boolean {
  return input.deltaMode === 0 && !input.shiftKey;
}

export function trackpadPanIdleDelay(interval: number | undefined): number {
  if (
    interval === undefined ||
    !Number.isFinite(interval) ||
    interval <= 0 ||
    interval > TRACKPAD_PAN_MAX_SAMPLE_INTERVAL_MS
  ) {
    return TRACKPAD_PAN_DEFAULT_IDLE_MS;
  }
  return Math.max(
    TRACKPAD_PAN_MIN_IDLE_MS,
    Math.min(TRACKPAD_PAN_MAX_IDLE_MS, interval * TRACKPAD_PAN_IDLE_INTERVAL_FACTOR),
  );
}

export class TrackpadPanMomentum {
  readonly #momentum = new HorizontalPanMomentum();
  #idleDelay = TRACKPAD_PAN_DEFAULT_IDLE_MS;
  #lastSampleTimestamp: number | undefined;
  #releaseDeadline: number | undefined;
  #clock: TrackpadPanClock;

  public constructor(clock: TrackpadPanClock) {
    this.#clock = clock;
  }

  public get active(): boolean {
    return this.#releaseDeadline !== undefined || this.#momentum.active;
  }

  public record(screenDeltaX: number): void {
    const timestamp = this.#clock.performance.now();
    if (!validSample(screenDeltaX, timestamp)) return;
    if (this.#momentum.active) this.#momentum.cancel();
    this.#updateIdleDelay(timestamp);
    this.#momentum.record(screenDeltaX, timestamp);
    this.#lastSampleTimestamp = timestamp;
    this.#releaseDeadline = timestamp + this.#idleDelay;
  }

  public advance(timestamp: number): number {
    const releaseDeadline = this.#releaseDeadline;
    if (releaseDeadline !== undefined) {
      if (timestamp < releaseDeadline) return 0;
      this.#releaseDeadline = undefined;
      const sampleTimestamp = this.#lastSampleTimestamp;
      if (
        sampleTimestamp === undefined ||
        !this.#momentum.release(sampleTimestamp, releaseDeadline)
      ) {
        return 0;
      }
    }
    return this.#momentum.advance(timestamp);
  }

  public cancel(): void {
    this.#momentum.cancel();
    this.#idleDelay = TRACKPAD_PAN_DEFAULT_IDLE_MS;
    this.#lastSampleTimestamp = undefined;
    this.#releaseDeadline = undefined;
  }

  public transferClock(clock: TrackpadPanClock): void {
    if (clock === this.#clock) return;
    this.cancel();
    this.#clock = clock;
  }

  #updateIdleDelay(timestamp: number): void {
    const previousTimestamp = this.#lastSampleTimestamp;
    this.#idleDelay = trackpadPanIdleDelay(
      previousTimestamp === undefined ? undefined : timestamp - previousTimestamp,
    );
  }
}

function validSample(screenDeltaX: number, timestamp: number): boolean {
  return (
    Number.isFinite(screenDeltaX) &&
    screenDeltaX !== 0 &&
    Number.isFinite(timestamp) &&
    timestamp >= 0
  );
}
