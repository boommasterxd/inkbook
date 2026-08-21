import {
  StaleWorkerResultError,
  WORKER_PROTOCOL_VERSION,
  WorkerRequestCancelledError,
  type WorkerResponse,
  type WorkerRevision,
} from "./protocol";
import type { PendingTask } from "./scheduler-types";
import { isValidWorkerOutputLength } from "./work-profiles";

export type WorkerResponseOutcome =
  | { readonly kind: "ignore" }
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "complete"; readonly output: unknown };

export function handleWorkerResponse(
  value: unknown,
  task: PendingTask,
): WorkerResponseOutcome {
  const response = parseWorkerResponse(value, task.id, task.maxOutputBytes);
  if (response === undefined) {
    return isMatchingWorkerResponse(value, task.id)
      ? protocolError("Worker response violates its protocol.")
      : { kind: "ignore" };
  }
  if (response.kind === "cancelled" || task.cancelled) {
    return protocolError(new WorkerRequestCancelledError());
  }
  if (response.kind === "error") {
    return protocolError(response.message ?? "Worker request failed.");
  }
  if (!sameWorkerRevision(response.revision, task.revision)) {
    return protocolError(new StaleWorkerResultError());
  }
  return handleStructuredResponse(response, task);
}

function handleStructuredResponse(
  response: Extract<WorkerResponse, { readonly kind: "structured-complete" }>,
  task: PendingTask,
): WorkerResponseOutcome {
  if (
    !isValidWorkerOutputLength(
      task.workKind,
      response.byteLength,
      task.maxOutputBytes,
    )
  ) {
    return protocolError("Worker result violates its work contract.");
  }
  try {
    return {
      kind: "complete",
      output: task.normalizeStructuredResult(response.payload),
    };
  } catch {
    return protocolError("Worker result violates its work contract.");
  }
}

function protocolError(value: Error | string): WorkerResponseOutcome {
  return {
    kind: "error",
    error: value instanceof Error ? value : new Error(value),
  };
}

function parseWorkerResponse(
  value: unknown,
  requestId: number,
  maxOutputBytes: number,
): WorkerResponse | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<WorkerResponse>;
  if (
    candidate.protocolVersion !== WORKER_PROTOCOL_VERSION ||
    candidate.requestId !== requestId
  ) {
    return undefined;
  }
  if (candidate.kind === "cancelled" || candidate.kind === "error") {
    return candidate as WorkerResponse;
  }
  if (
    candidate.kind === "structured-complete" &&
    typeof candidate.byteLength === "number" &&
    Number.isSafeInteger(candidate.byteLength) &&
    candidate.byteLength >= 0 &&
    candidate.byteLength <= maxOutputBytes &&
    isWorkerRevision(candidate.revision)
  ) {
    return candidate as WorkerResponse;
  }
  return undefined;
}

function isMatchingWorkerResponse(value: unknown, requestId: number): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (value as { requestId?: unknown }).requestId === requestId;
}

function sameWorkerRevision(
  left: WorkerRevision,
  right: WorkerRevision,
): boolean {
  return left.scene === right.scene && left.layout === right.layout;
}

function isWorkerRevision(value: unknown): value is WorkerRevision {
  if (typeof value !== "object" || value === null) return false;
  const revision = value as Partial<WorkerRevision>;
  return (
    typeof revision.scene === "number" &&
    Number.isSafeInteger(revision.scene) &&
    revision.scene >= 0 &&
    typeof revision.layout === "number" &&
    Number.isSafeInteger(revision.layout) &&
    revision.layout >= 0
  );
}
