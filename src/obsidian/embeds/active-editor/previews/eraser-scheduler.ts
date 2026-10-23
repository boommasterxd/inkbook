import type { EraserSliceScheduler } from "../../../../editor/gestures/public";
import type { WorkScheduler } from "../../../../domain/scheduling/work-scheduler";

export class EraserFrameScheduler implements EraserSliceScheduler {
  readonly #workScheduler: WorkScheduler;
  readonly #isStale: () => boolean;
  readonly #abort = new AbortController();
  #cancelled = false;

  public constructor(workScheduler: WorkScheduler, isStale: () => boolean = () => false) {
    this.#isStale = isStale;
    this.#workScheduler = workScheduler;
  }

  public isCancelled(): boolean {
    return this.#cancelled || this.#isStale();
  }

  public shouldYield(): boolean {
    return this.#workScheduler.shouldYield();
  }

  public yieldControl(): Promise<void> {
    if (this.#cancelled) return Promise.resolve();
    return this.#workScheduler.nextFrame(this.#abort.signal, "frame").catch(() => {
      this.#cancelled = true;
    });
  }

  public cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#abort.abort();
  }
}
