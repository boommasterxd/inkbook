import type { StoreSliceScheduler } from "./types";

export async function yieldWhenRequested(
  scheduler: StoreSliceScheduler,
): Promise<0 | 1 | "cancelled"> {
  if (cancelled(scheduler)) return "cancelled";
  if (!scheduler.shouldYield()) return 0;
  await scheduler.yieldControl();
  return cancelled(scheduler) ? "cancelled" : 1;
}

export function cancelled(scheduler: StoreSliceScheduler): boolean {
  return scheduler.isCancelled?.() ?? false;
}
