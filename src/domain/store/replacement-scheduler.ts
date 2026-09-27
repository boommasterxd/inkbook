import type { StoreSliceScheduler } from "./types";

export function yieldWhenRequested(
  scheduler: StoreSliceScheduler,
): 0 | "cancelled" | Promise<1 | "cancelled"> {
  if (cancelled(scheduler)) return "cancelled";
  if (!scheduler.shouldYield()) return 0;
  return scheduler.yieldControl().then(() => (cancelled(scheduler) ? "cancelled" : 1));
}

export function cancelled(scheduler: StoreSliceScheduler): boolean {
  return scheduler.isCancelled?.() ?? false;
}

/** Tracks actual deadline handoffs without creating a Promise on the free-budget path. */
export class ReplacementCheckpoint {
  public yields = 0;

  public constructor(private readonly scheduler: StoreSliceScheduler) {}

  public checkpoint(): boolean | Promise<boolean> {
    const result = yieldWhenRequested(this.scheduler);
    if (result === "cancelled") return false;
    if (result === 0) return true;
    return result.then((yielded) => {
      if (yielded === "cancelled") return false;
      this.yields += yielded;
      return true;
    });
  }
}
