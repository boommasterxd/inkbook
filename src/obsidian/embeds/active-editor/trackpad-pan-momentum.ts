import { HorizontalPanMomentum } from "../../../editor/zoom/index";

export const TRACKPAD_PAN_DEFAULT_IDLE_MS = 24;
export const TRACKPAD_PAN_MAX_IDLE_MS = 40;
export const TRACKPAD_PAN_MIN_IDLE_MS = 8;
export const TRACKPAD_PAN_MAX_RESPONSE = 1.75;
const TRACKPAD_PAN_IDLE_INTERVAL_FACTOR = 1.5;
const TRACKPAD_PAN_MAX_SAMPLE_INTERVAL_MS = 100;
const TRACKPAD_PAN_RESPONSE_FULL_SPEED = 2_500;
const TRACKPAD_PAN_RESPONSE_START_SPEED = 250;
const TRACKPAD_PAN_RESPONSE_DEFAULT_INTERVAL_MS = 1_000 / 60;

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

export function responsiveTrackpadPanDelta(
  screenDeltaX: number,
  interval: number | undefined,
): number {
  const sampleInterval = validSampleInterval(interval)
    ? interval
    : TRACKPAD_PAN_RESPONSE_DEFAULT_INTERVAL_MS;
  const speed = (Math.abs(screenDeltaX) * 1_000) / sampleInterval;
  const progress = Math.max(
    0,
    Math.min(
      1,
      (speed - TRACKPAD_PAN_RESPONSE_START_SPEED) /
        (TRACKPAD_PAN_RESPONSE_FULL_SPEED - TRACKPAD_PAN_RESPONSE_START_SPEED),
    ),
  );
  const adjusted = screenDeltaX * (1 + progress * (TRACKPAD_PAN_MAX_RESPONSE - 1));
  return Number.isFinite(adjusted) ? adjusted : screenDeltaX;
}

export class TrackpadPanMomentum {
  readonly #momentum = new HorizontalPanMomentum();
  #idleDelay = TRACKPAD_PAN_DEFAULT_IDLE_MS;
  #lastDirection = 0;
  #lastSampleTimestamp: number | undefined;
  #releaseDeadline: number | undefined;
  #clock: TrackpadPanClock;

  public constructor(clock: TrackpadPanClock) {
    this.#clock = clock;
  }

  public get active(): boolean {
    return this.#releaseDeadline !== undefined || this.#momentum.active;
  }

  public record(screenDeltaX: number): number | undefined {
    const timestamp = this.#clock.performance.now();
    if (!validSample(screenDeltaX, timestamp)) return undefined;
    const interval = this.#sampleInterval(timestamp);
    const direction = Math.sign(screenDeltaX);
    if (this.#momentum.active || (this.#lastDirection !== 0 && direction !== this.#lastDirection)) {
      this.#momentum.cancel();
    }
    this.#idleDelay = trackpadPanIdleDelay(interval);
    const adjustedDelta = responsiveTrackpadPanDelta(screenDeltaX, interval);
    this.#momentum.record(adjustedDelta, timestamp);
    this.#lastDirection = direction;
    this.#lastSampleTimestamp = timestamp;
    this.#releaseDeadline = timestamp + this.#idleDelay;
    return adjustedDelta;
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
    this.#lastDirection = 0;
    this.#lastSampleTimestamp = undefined;
    this.#releaseDeadline = undefined;
  }

  public transferClock(clock: TrackpadPanClock): void {
    if (clock === this.#clock) return;
    this.cancel();
    this.#clock = clock;
  }

  #sampleInterval(timestamp: number): number | undefined {
    const previousTimestamp = this.#lastSampleTimestamp;
    return previousTimestamp === undefined ? undefined : timestamp - previousTimestamp;
  }
}

function validSampleInterval(interval: number | undefined): interval is number {
  return (
    interval !== undefined &&
    Number.isFinite(interval) &&
    interval > 0 &&
    interval <= TRACKPAD_PAN_MAX_SAMPLE_INTERVAL_MS
  );
}

function validSample(screenDeltaX: number, timestamp: number): boolean {
  return (
    Number.isFinite(screenDeltaX) &&
    screenDeltaX !== 0 &&
    Number.isFinite(timestamp) &&
    timestamp >= 0
  );
}
