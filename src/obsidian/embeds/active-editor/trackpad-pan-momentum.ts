import { HorizontalPanMomentum } from "../../../editor/zoom/index";

export const TRACKPAD_PAN_IDLE_MS = 80;
const TRACKPAD_PIXEL_DELTA_LIMIT = 100;

interface TrackpadPanScheduler {
  clearTimeout(handle: number): void;
  readonly performance: Pick<Performance, "now">;
  setTimeout(callback: () => void, delay: number): number;
}

export interface TrackpadPanInput {
  readonly deltaMode: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly shiftKey: boolean;
}

export function isTrackpadPanInput(input: TrackpadPanInput): boolean {
  return (
    input.deltaMode === 0 &&
    !input.shiftKey &&
    Math.abs(input.deltaX) < TRACKPAD_PIXEL_DELTA_LIMIT &&
    Math.abs(input.deltaY) < TRACKPAD_PIXEL_DELTA_LIMIT
  );
}

export class TrackpadPanMomentum {
  readonly #momentum = new HorizontalPanMomentum();
  readonly #onRelease: () => void;
  #releaseTimer: number | undefined;
  #scheduler: TrackpadPanScheduler;
  #lastTimestamp = 0;

  public constructor(scheduler: TrackpadPanScheduler, onRelease: () => void) {
    this.#onRelease = onRelease;
    this.#scheduler = scheduler;
  }

  public get active(): boolean {
    return this.#momentum.active;
  }

  public record(screenDeltaX: number): void {
    const timestamp = this.#scheduler.performance.now();
    if (!Number.isFinite(screenDeltaX) || screenDeltaX === 0 || !validTime(timestamp)) return;
    if (this.#momentum.active) this.#momentum.cancel();
    this.#momentum.record(screenDeltaX, timestamp);
    this.#lastTimestamp = timestamp;
    this.#clearReleaseTimer();
    this.#releaseTimer = this.#scheduler.setTimeout(() => {
      this.#releaseTimer = undefined;
      if (this.#momentum.release(this.#lastTimestamp, this.#scheduler.performance.now())) {
        this.#onRelease();
      }
    }, TRACKPAD_PAN_IDLE_MS);
  }

  public advance(timestamp: number): number {
    return this.#momentum.advance(timestamp);
  }

  public cancel(): void {
    this.#clearReleaseTimer();
    this.#momentum.cancel();
  }

  public transferScheduler(scheduler: TrackpadPanScheduler): void {
    if (scheduler === this.#scheduler) return;
    this.cancel();
    this.#scheduler = scheduler;
  }

  #clearReleaseTimer(): void {
    if (this.#releaseTimer === undefined) return;
    this.#scheduler.clearTimeout(this.#releaseTimer);
    this.#releaseTimer = undefined;
  }
}

function validTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
