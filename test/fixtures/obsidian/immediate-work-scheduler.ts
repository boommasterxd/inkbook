import type { WorkScheduler } from "../../../src/domain/scheduling/work-scheduler";

/** Immediate continuation for tests that assert work rather than frame timing. */
export function immediateWorkScheduler(shouldYield: () => boolean = () => false): WorkScheduler {
  return {
    now: () => 0,
    deadline: () => 1,
    budgetMs: () => 1,
    shouldYield,
    requestFrame: (callback) => {
      queueMicrotask(() => callback(0));
      return 1;
    },
    cancelFrame: () => undefined,
    checkpoint: () => undefined,
    nextFrame: () => Promise.resolve(),
    dispose: () => undefined,
  };
}

/** Holds cooperative continuations until the test admits the next slice. */
export function pausedWorkScheduler() {
  let paused = true;
  const waiters = new Set<() => void>();
  return {
    scheduler: {
      ...immediateWorkScheduler(),
      shouldYield: () => paused,
      checkpoint: () => new Promise<void>((resolve) => waiters.add(resolve)),
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      for (const release of waiters) release();
      waiters.clear();
    },
  };
}

/** Preserves a fixture window's visual-frame behavior while work continuation stays immediate. */
export function nativeFrameWorkScheduler(ownerWindow: Window | null): WorkScheduler {
  if (ownerWindow === null) throw new Error("The test presentation has no owning window.");
  return {
    ...immediateWorkScheduler(),
    requestFrame: (callback) => ownerWindow.requestAnimationFrame(callback),
    cancelFrame: (handle) => ownerWindow.cancelAnimationFrame(handle),
  };
}
