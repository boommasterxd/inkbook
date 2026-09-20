import type { StoreSliceScheduler } from "./types";

const MAX_CHECKPOINTS_PER_SLICE = 128;

export function minimumProgressScheduler(scheduler: StoreSliceScheduler): StoreSliceScheduler {
  let checkpoints = 0;
  return {
    ...(scheduler.isCancelled === undefined
      ? {}
      : { isCancelled: () => scheduler.isCancelled?.() ?? false }),
    shouldYield: () => {
      checkpoints += 1;
      return (
        checkpoints > 1 && (checkpoints >= MAX_CHECKPOINTS_PER_SLICE || scheduler.shouldYield())
      );
    },
    yieldControl: async () => {
      await scheduler.yieldControl();
      checkpoints = 0;
    },
  };
}

export async function checkpoint(scheduler: StoreSliceScheduler): Promise<boolean> {
  if (scheduler.isCancelled?.() ?? false) return false;
  if (scheduler.shouldYield()) await scheduler.yieldControl();
  return !(scheduler.isCancelled?.() ?? false);
}
