import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

export function createMainThreadCheckpoint(
  workScheduler?: WorkScheduler,
  waitForBackground?: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    if (waitForBackground !== undefined) await waitForBackground();
    const pending = workScheduler?.checkpoint();
    if (pending !== undefined) await pending;
  };
}
