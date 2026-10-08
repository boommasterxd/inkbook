import { HorizontalPanMomentum } from "../../../editor/zoom/index";

const DEFAULT_IDLE_MS = 48;
const MIN_IDLE_MS = 32;
const MAX_IDLE_MS = 80;
const BURST_GAP_MS = 120;

export function trackpadPanSampleTime(timestamp: number | undefined, now: number): number {
  return timestamp !== undefined && Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= now
    ? timestamp
    : now;
}

/** Wheel exposes neither physical contact nor momentum phases. */
export class TrackpadPanMomentum {
  readonly #momentum = new HorizontalPanMomentum();
  #lastSampleTime: number | undefined;
  #releaseDeadline: number | undefined;
  #native = false;

  public get active(): boolean {
    return this.#releaseDeadline !== undefined || this.#momentum.active;
  }

  public record(delta: number, timestamp: number, cancelable: boolean): void {
    if (!Number.isFinite(delta) || !Number.isFinite(timestamp) || timestamp < 0) return;
    const previous = this.#lastSampleTime;
    const interval = previous === undefined ? undefined : timestamp - previous;
    if (interval !== undefined && (interval < 0 || interval > BURST_GAP_MS)) this.cancel();
    if (this.#momentum.active) this.#momentum.cancel();
    this.#lastSampleTime = timestamp;
    if (!cancelable) {
      this.#native = true;
      this.#releaseDeadline = undefined;
      this.#momentum.cancel();
    }
    if (this.#native || delta === 0) return;
    this.#momentum.record(delta, timestamp);
    const delay =
      interval !== undefined && interval > 0 && interval <= BURST_GAP_MS
        ? Math.max(MIN_IDLE_MS, Math.min(MAX_IDLE_MS, interval * 3))
        : DEFAULT_IDLE_MS;
    this.#releaseDeadline = timestamp + delay;
  }

  public advance(timestamp: number): number {
    const deadline = this.#releaseDeadline;
    if (deadline !== undefined) {
      if (timestamp < deadline) return 0;
      this.#releaseDeadline = undefined;
      if (
        this.#lastSampleTime === undefined ||
        !this.#momentum.release(this.#lastSampleTime, deadline)
      ) {
        return 0;
      }
    }
    return this.#momentum.advance(timestamp);
  }

  public cancel(): void {
    this.#momentum.cancel();
    this.#lastSampleTime = undefined;
    this.#releaseDeadline = undefined;
    this.#native = false;
  }
}
