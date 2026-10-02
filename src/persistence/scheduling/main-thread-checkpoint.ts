import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

export function createMainThreadCheckpoint(
  workScheduler?: WorkScheduler,
  waitForBackground?: () => Promise<void> | undefined,
): () => Promise<void> | undefined {
  return () => {
    const ready = waitForBackground?.();
    return ready === undefined
      ? workScheduler?.checkpoint()
      : ready.then(() => workScheduler?.checkpoint());
  };
}
