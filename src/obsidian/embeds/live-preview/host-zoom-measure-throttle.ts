import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";

const HOST_MEASURE_INTERVAL_MS = 150;

/** Semantic host-layout throttle; actual work retains central frame admission. */
export class HostZoomMeasureThrottle {
  readonly #window: Window;
  readonly #scheduler: WorkScheduler;
  #callback: (() => void) | undefined;
  #lastMeasureTime = -Infinity;
  #timer: number | undefined;
  #frame: number | undefined;
  #generation = 0;

  constructor(ownerWindow: Window, scheduler: WorkScheduler) {
    this.#window = ownerWindow;
    this.#scheduler = scheduler;
  }

  request(callback: () => void): void {
    this.#callback = callback;
    if (this.#timer !== undefined || this.#frame !== undefined) return;
    const delay = HOST_MEASURE_INTERVAL_MS - (this.#scheduler.now() - this.#lastMeasureTime);
    if (delay <= 0) this.#run();
    else this.#armTimer(delay);
  }

  cancel(): void {
    this.#generation += 1;
    if (this.#timer !== undefined) this.#window.clearTimeout(this.#timer);
    if (this.#frame !== undefined) this.#scheduler.cancelFrame(this.#frame);
    this.#timer = undefined;
    this.#frame = undefined;
    this.#callback = undefined;
  }

  #armTimer(delay: number): void {
    const generation = this.#generation;
    this.#timer = this.#window.setTimeout(() => {
      if (generation !== this.#generation) return;
      this.#timer = undefined;
      this.#frame = this.#scheduler.requestFrame(() => {
        if (generation !== this.#generation) return;
        this.#frame = undefined;
        this.#run();
      });
    }, delay);
  }

  #run(): void {
    const callback = this.#callback;
    this.#callback = undefined;
    this.#lastMeasureTime = this.#scheduler.now();
    callback?.();
  }
}
