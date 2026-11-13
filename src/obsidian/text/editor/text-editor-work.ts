import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";

/** Both owned pipelines share admission and cancellation without adding another work budget. */
export function runTextEditorWork<Value>(
  steps: Generator<void, Value>,
  scheduler: WorkScheduler,
  signal: AbortSignal,
  complete: (value: Value) => void,
): Promise<void> | undefined {
  if (signal.aborted) return;
  let step = steps.next();
  while (!step.done) {
    if (signal.aborted) return;
    const continuation = scheduler.checkpoint(signal, "input");
    if (continuation)
      return continuation.then(
        () => runTextEditorWork(steps, scheduler, signal, complete),
        (error: unknown) => {
          if (!signal.aborted) throw error;
        },
      );
    step = steps.next();
  }
  if (!signal.aborted) complete(step.value);
  return undefined;
}
