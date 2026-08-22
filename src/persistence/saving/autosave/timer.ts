import type { AutosaveClock } from "./types";

export const ACTIVE_GESTURE_RETRY_MS = 200;
export const AUTOSAVE_DELAY_MS = 500;

export class AutosaveTimer {
  readonly #clock: AutosaveClock;
  readonly #onElapsed: () => void;
  #handle: unknown = null;

  public constructor(clock: AutosaveClock, onElapsed: () => void) {
    this.#clock = clock;
    this.#onElapsed = onElapsed;
  }

  public schedule(delay: number): void {
    this.clear();
    this.#handle = this.#clock.setTimeout(() => {
      this.#handle = null;
      this.#onElapsed();
    }, delay);
  }

  public clear(): void {
    if (this.#handle === null) return;
    this.#clock.clearTimeout(this.#handle);
    this.#handle = null;
  }
}
