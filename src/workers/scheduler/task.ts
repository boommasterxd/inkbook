import type { PendingTask, TaskInput } from "./scheduler-types";
import type { WorkerRevision } from "./protocol";

export function createPendingTask(input: TaskInput, id: number): PendingTask {
  let resolveResult: PendingTask["resolve"] = () => undefined;
  let rejectResult: PendingTask["reject"] = () => undefined;
  const promise = new Promise<unknown>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  return {
    id,
    revision: input.revision,
    priority: input.priority,
    mode: input.mode,
    workKind: input.workKind,
    byteLength: input.inputBytes,
    maxOutputBytes: input.maxOutputBytes,
    scratchBytes: input.scratchBytes,
    inputBytes: input.inputBytes,
    reservedBytes: input.inputBytes + input.maxOutputBytes + input.scratchBytes,
    workerFirst: input.workerFirst,
    resolve: resolveResult,
    reject: rejectResult,
    cancelled: false,
    sentToWorker: false,
    structuredPayload: input.structuredPayload,
    normalizeStructuredResult: input.normalizeStructuredResult,
    fallbackProcessorFactory: input.fallbackProcessorFactory,
    promise,
  };
}

export function assertWorkerRevision(revision: WorkerRevision): void {
  if (
    !Number.isSafeInteger(revision.scene) ||
    revision.scene < 0 ||
    !Number.isSafeInteger(revision.layout) ||
    revision.layout < 0
  ) {
    throw new RangeError(
      "Worker revisions must be non-negative safe integers.",
    );
  }
}

export function toWorkerProcessingError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Fallback processing failed.");
}
