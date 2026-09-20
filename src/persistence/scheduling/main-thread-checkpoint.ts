import { yieldToMainThread } from "./main-thread-yield";

const DEFAULT_SLICE_MS = 4;

/** Reads the current caller-owned budget at every cooperative boundary. */
export function createMainThreadDeadline(sliceBudgetMs?: () => number) {
  let started = performance.now();
  return {
    exceeded: (): boolean => {
      const requested = sliceBudgetMs?.() ?? DEFAULT_SLICE_MS;
      const budget = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_SLICE_MS;
      return performance.now() - started >= budget;
    },
    restart: (): void => {
      started = performance.now();
    },
  };
}

export function createMainThreadCheckpoint(
  sliceBudgetMs?: () => number,
  waitForBackground?: () => Promise<void>,
): () => Promise<void> {
  const deadline = createMainThreadDeadline(sliceBudgetMs);
  return async () => {
    if (deadline.exceeded()) {
      await yieldToMainThread();
      deadline.restart();
    }
    if (waitForBackground) await waitForBackground();
  };
}
