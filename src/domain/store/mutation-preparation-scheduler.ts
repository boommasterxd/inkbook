import type { StoreSliceScheduler } from "./types";

const MAX_WORK_PER_SLICE = 2048;

/** Cheap ID visits cost one unit; element traversal costs sixteen (at most 128 per slice). */
export class MutationPreparationScheduler {
  #work = 0;

  public constructor(private readonly scheduler: StoreSliceScheduler) {}

  public async checkpoint(cost = 1): Promise<boolean> {
    if (this.scheduler.isCancelled?.() ?? false) return false;
    if (
      this.#work > 0 &&
      (this.#work + cost > MAX_WORK_PER_SLICE || this.scheduler.shouldYield())
    ) {
      await this.scheduler.yieldControl();
      this.#work = 0;
    }
    if (this.scheduler.isCancelled?.() ?? false) return false;
    this.#work += cost;
    return true;
  }
}
