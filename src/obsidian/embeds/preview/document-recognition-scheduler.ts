import type { FrameCancellation, WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { createWindowSchedulerForwarding } from "../../performance/window-scheduler-forwarding";

/** Routes a single shared inspection through the current requester's window budget. */
export function createRecognitionWorkScheduler(
  current: () => WorkScheduler,
  transferSignal: () => AbortSignal,
  cancellation: AbortSignal,
): WorkScheduler {
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
    ...createWindowSchedulerForwarding(current),
    checkpoint: (signal, priority) => {
      cancellation.throwIfAborted();
      if (signal !== undefined) {
        if (signal.aborted)
          return Promise.reject(
            signal.reason instanceof Error ? signal.reason : new Error("Frame work cancelled."),
          );
        if (!current().shouldYield()) return undefined;
      }
      return wait((scheduler, active) => scheduler.checkpoint(active, priority), signal);
    },
    nextFrame: (signal, priority) =>
      wait((scheduler, active) => scheduler.nextFrame(active, priority), signal) ??
      Promise.resolve(),
  };
}
