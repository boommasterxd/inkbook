import type {
  FrameCancellation,
  WorkScheduler,
} from "../../../src/domain/scheduling/work-scheduler";

interface FramePort {
  cancelAnimationFrame(handle: number): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
}

interface WorkSchedulerOptions {
  readonly budgetMs?: () => number;
  readonly now?: () => number;
  readonly shouldYield?: () => boolean;
}

/** Keeps direct component tests on their existing deterministic frame driver. */
export function workSchedulerFromFrames(
  frames: FramePort,
  options: WorkSchedulerOptions = {},
): WorkScheduler {
  const now = options.now ?? (() => performance.now());
  const budgetMs = options.budgetMs ?? (() => 8);
  const shouldYield = options.shouldYield ?? (() => false);
  const requestFrame = (callback: (timestamp: number) => void): number =>
    frames.requestAnimationFrame(callback);
  const cancelFrame = (handle: number): void => frames.cancelAnimationFrame(handle);
  const nextFrame = (signal?: FrameCancellation): Promise<void> =>
    new Promise((resolve, reject) => {
      const abortError =
        signal?.reason instanceof Error ? signal.reason : new Error("Frame work aborted.");
      if (signal?.aborted) return reject(abortError);
      const onAbort = (): void => {
        cancelFrame(handle);
        reject(abortError);
      };
      const handle = requestFrame(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  return {
    now,
    budgetMs,
    deadline: () => now() + budgetMs(),
    shouldYield,
    requestFrame,
    cancelFrame,
    checkpoint: (signal) => (shouldYield() ? nextFrame(signal) : undefined),
    nextFrame,
    dispose: () => undefined,
  };
}
