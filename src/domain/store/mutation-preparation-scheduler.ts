import type { StoreSliceScheduler } from "./types";

const MAX_WORK_PER_SLICE = 2048;

/** Cheap ID visits cost one unit; element traversal costs sixteen (at most 128 per slice). */
export class MutationPreparationScheduler {
  #work = 0;
  #pendingCost: number | undefined;

  public constructor(private readonly scheduler: StoreSliceScheduler) {}

  /** Returns synchronously while work can continue; otherwise the caller must await resume(). */
  public checkpoint(cost = 1): boolean {
    this.#pendingCost = undefined;
    if (this.scheduler.isCancelled?.() ?? false) return false;
    if (
      this.#work > 0 &&
      (this.#work + cost > MAX_WORK_PER_SLICE || this.scheduler.shouldYield())
    ) {
      this.#pendingCost = cost;
      return false;
    }
    this.#work += cost;
    return true;
  }

  public async resume(): Promise<boolean> {
    const cost = this.#pendingCost;
    this.#pendingCost = undefined;
    if (cost === undefined) return false;
    await this.scheduler.yieldControl();
    this.#work = cost;
    return !(this.scheduler.isCancelled?.() ?? false);
  }
}
