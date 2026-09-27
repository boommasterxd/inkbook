import type { FrameCancellation, WorkScheduler } from "../../domain/scheduling/work-scheduler";

/** Routes a single shared inspection through the current requester's window budget. */
export function createRecognitionWorkScheduler(
  current: () => WorkScheduler,
  transferSignal: () => AbortSignal,
  cancellation: AbortSignal,
): WorkScheduler {
  const frames = new Map<number, { scheduler: WorkScheduler; handle: number }>();
  let nextHandle = 0;

  const wait = (
    run: (scheduler: WorkScheduler, signal: FrameCancellation) => Promise<void> | undefined,
    callerSignal?: FrameCancellation,
  ): Promise<void> | undefined => {
    cancellation.throwIfAborted();
    const scheduler = current();
    const transfer = transferSignal();
    let signal: FrameCancellation = transfer;
    let release = (): void => undefined;
    if (callerSignal !== undefined) {
      const combined = new AbortController();
      const abort = (): void => combined.abort();
      callerSignal.addEventListener("abort", abort, { once: true });
      transfer.addEventListener("abort", abort, { once: true });
      if (callerSignal.aborted || transfer.aborted) abort();
      signal = combined.signal;
      release = () => {
        callerSignal.removeEventListener("abort", abort);
        transfer.removeEventListener("abort", abort);
      };
    }
    let pending: Promise<void> | undefined;
    try {
      pending = run(scheduler, signal);
    } catch (error: unknown) {
      release();
      throw error;
    }
    if (pending === undefined) {
      release();
      return undefined;
    }
    return pending.then(
      () => release(),
      (error: unknown) => {
        release();
        if (cancellation.aborted || callerSignal?.aborted) throw error;
        if (!transfer.aborted && current() === scheduler) throw error;
        return wait(run, callerSignal);
      },
    );
  };

  return {
    now: () => current().now(),
    deadline: () => current().deadline(),
    budgetMs: () => current().budgetMs(),
    shouldYield: () => current().shouldYield(),
    requestFrame: (callback, priority) => {
      const scheduler = current();
      const handle = ++nextHandle;
      frames.set(handle, {
        scheduler,
        handle: scheduler.requestFrame((time) => {
          frames.delete(handle);
          callback(time);
        }, priority),
      });
      return handle;
    },
    cancelFrame: (handle) => {
      const frame = frames.get(handle);
      if (frame === undefined) return;
      frames.delete(handle);
      frame.scheduler.cancelFrame(frame.handle);
    },
    checkpoint: (signal) => {
      cancellation.throwIfAborted();
      if (signal !== undefined) {
        if (signal.aborted)
          return Promise.reject(
            signal.reason instanceof Error ? signal.reason : new Error("Frame work cancelled."),
          );
        if (!current().shouldYield()) return undefined;
      }
      return wait((scheduler, active) => scheduler.checkpoint(active), signal);
    },
    nextFrame: (signal, priority) =>
      wait((scheduler, active) => scheduler.nextFrame(active, priority), signal) ??
      Promise.resolve(),
    dispose: () => {
      for (const frame of frames.values()) frame.scheduler.cancelFrame(frame.handle);
      frames.clear();
    },
  };
}
