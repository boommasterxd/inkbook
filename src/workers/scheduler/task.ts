import type { PendingTask, TaskInput } from "./scheduler-types";
import { MAX_WORKER_REQUEST_BYTES } from "./protocol";
import type { WorkerRevision } from "./protocol";
import { isValidWorkerOutputLength } from "./work-profiles";

export function createPendingTask(input: TaskInput, id: number): PendingTask {
  let resolveResult: PendingTask["resolve"] = () => undefined;
  let rejectResult: PendingTask["reject"] = () => undefined;
  const promise = new Promise<unknown>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const inputBytes = input.inputBytes ?? input.input.byteLength;
  return {
    id,
    revision: input.revision,
    priority: input.priority,
    mode: input.mode,
    workKind: input.workKind,
    input: input.input,
    byteLength: inputBytes,
    maxOutputBytes: input.maxOutputBytes,
    scratchBytes: input.scratchBytes,
    reservedBytes: inputBytes + input.maxOutputBytes + input.scratchBytes,
    workerFirst: input.workerFirst,
    requireSameSize: input.requireSameSize,
    resolve: resolveResult,
    reject: rejectResult,
    cancelled: false,
    sentToWorker: false,
    ...(input.structuredPayload === undefined
      ? {}
      : { structuredPayload: input.structuredPayload }),
    ...(input.normalizeStructuredResult === undefined
      ? {}
      : { normalizeStructuredResult: input.normalizeStructuredResult }),
    ...(input.suppliedFallbackProcessorFactory === undefined
      ? {}
      : {
          suppliedFallbackProcessorFactory:
            input.suppliedFallbackProcessorFactory,
        }),
    offset: 0,
    promise,
  };
}

export function assertOwnedStaging(input: Uint8Array<ArrayBuffer>): void {
  if (
    input.byteLength > MAX_WORKER_REQUEST_BYTES ||
    input.byteOffset !== 0 ||
    input.byteLength !== input.buffer.byteLength
  ) {
    throw new RangeError("The staging buffer violates worker request bounds.");
  }
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

export function isAdmissibleByteOutput(
  task: PendingTask,
  output: Uint8Array,
): output is Uint8Array<ArrayBuffer> {
  return (
    output.buffer instanceof ArrayBuffer &&
    output.byteOffset === 0 &&
    output.byteLength === output.buffer.byteLength &&
    (!task.requireSameSize || output.byteLength === task.byteLength) &&
    isValidWorkerOutputLength(
      task.workKind,
      output.byteLength,
      task.maxOutputBytes,
    )
  );
}

export function toWorkerProcessingError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Fallback byte processing failed.");
}
