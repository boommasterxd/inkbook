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
