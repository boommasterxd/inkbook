export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Semantic I/O watchdog timer, independent from cooperative work admission. */
function scheduleRequestTimeout(callback: () => void, milliseconds: number): () => void {
  const handle = setTimeout(callback, milliseconds);
  return () => clearTimeout(handle);
}

/** Counts active request time while retaining one cancellable timer across scheduler pauses. */
export class RequestWatchdog {
  readonly #callback: () => void;
  readonly #now: () => number;
  readonly #scheduleTimeout: typeof scheduleRequestTimeout;
  #remaining: number;
  #started = 0;
  #cancelTimer: (() => void) | undefined;
  #gatePaused = false;
  #admissionPauses = 0;
  #cancelled = false;

  public constructor(
    callback: () => void,
    milliseconds: number,
    now: () => number,
    scheduleTimeout = scheduleRequestTimeout,
  ) {
    this.#callback = callback;
    this.#remaining = milliseconds;
    this.#now = now;
    this.#scheduleTimeout = scheduleTimeout;
    this.#refresh();
  }

  public setGatePaused(paused: boolean): void {
    this.#gatePaused = paused;
    this.#refresh();
  }

  public waitForAdmission(pending: Promise<void>): Promise<void> {
    this.#admissionPauses += 1;
    this.#refresh();
    return pending.finally(() => {
      this.#admissionPauses -= 1;
      this.#refresh();
    });
  }

  public cancel(): void {
    this.#cancelled = true;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
  }

  #refresh(): void {
    if (this.#cancelled) return;
    const paused = this.#gatePaused || this.#admissionPauses > 0;
    if (paused && this.#cancelTimer !== undefined) {
      const elapsed = Math.max(0, this.#now() - this.#started);
      this.#remaining = Math.max(0, this.#remaining - elapsed);
      this.#cancelTimer();
      this.#cancelTimer = undefined;
    } else if (!paused && this.#cancelTimer === undefined) {
      this.#started = this.#now();
      this.#cancelTimer = this.#scheduleTimeout(() => {
        this.#cancelled = true;
        this.#cancelTimer = undefined;
        this.#callback();
      }, this.#remaining);
    }
  }
}
