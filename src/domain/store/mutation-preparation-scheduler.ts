import type { StoreSliceScheduler } from "./types";

/** Checks the shared deadline before starting each preparation step. */
export class MutationPreparationScheduler {
  #pending = false;

  public constructor(private readonly scheduler: StoreSliceScheduler) {}

  /** Returns synchronously while work can continue; otherwise the caller must await resume(). */
  public checkpoint(): boolean {
    this.#pending = false;
    if (this.scheduler.isCancelled?.() ?? false) return false;
    if (this.scheduler.shouldYield()) {
      this.#pending = true;
      return false;
    }
    return true;
  }

  public async resume(): Promise<boolean> {
    if (!this.#pending) return false;
    this.#pending = false;
    await this.scheduler.yieldControl();
    return !(this.scheduler.isCancelled?.() ?? false);
  }

  public async run<T>(steps: Generator<void | boolean, T>): Promise<T | "cancelled"> {
    while (true) {
      if (!(this.checkpoint() || (await this.resume()))) return "cancelled";
      const step = steps.next();
      if (step.done) return step.value;
    }
  }
}
