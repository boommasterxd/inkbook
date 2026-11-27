import type { FrameCancellation, WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { createWindowSchedulerForwarding } from "../../performance/window-scheduler-forwarding";

type BackgroundGate = () => Promise<void> | undefined;

export function waitForRecognitionBackground(gates: ReadonlySet<BackgroundGate>) {
  const pending: Promise<void>[] = [];
  for (const gate of gates) {
    const ready = gate();
    if (ready !== undefined) pending.push(ready);
  }
  return pending.length === 0 ? undefined : Promise.all(pending).then(() => undefined);
}

/** Cancel only this consumer, leaving the coalesced document inspection available to other owners. */
export function waitForRecognitionResult<T>(
  pending: Promise<T>,
  gates: Set<BackgroundGate> | undefined,
  gate: BackgroundGate | undefined,
  signal: AbortSignal | undefined,
): Promise<T | undefined> {
  if (signal?.aborted === true) return Promise.resolve(undefined);
  if (gate === undefined && signal === undefined) return pending;
  if (gate !== undefined) gates?.add(gate);
  return new Promise((resolve, reject) => {
    let receiver:
      { resolve(value: T | undefined): void; reject(error: unknown): void } | undefined = {
      resolve: (value) => {
        release();
        resolve(value);
      },
      reject: (error) => {
        release();
        reject(error instanceof Error ? error : new Error("Inkbook preview recognition failed."));
      },
    };
    const abort = (): void => receiver?.resolve(undefined);
    function release(): void {
      receiver = undefined;
      if (gate !== undefined) gates?.delete(gate);
      signal?.removeEventListener("abort", abort);
    }
    signal?.addEventListener("abort", abort, { once: true });
    void pending.then(
      (value) => receiver?.resolve(value),
      (error: unknown) => receiver?.reject(error),
    );
  });
}

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
