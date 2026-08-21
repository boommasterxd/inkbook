// The wire version changes only when request or response compatibility changes.
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
export const WORKER_PROTOCOL_VERSION = 3 as const;
export const ACTIVE_WORKER_SLICE_MS = 2;
export const IDLE_WORKER_SLICE_MS = 4;
export const WORKER_ADMISSION_BYTES = 524_288;
export const MAX_WORKER_TASK_INPUT_BYTES = 16_777_216;
export const MAX_WORKER_TASK_OUTPUT_BYTES = 16_777_216;
export const MAX_WORKER_TASK_SCRATCH_BYTES = 8_388_608;
export const MAX_WORKER_DECODED_OUTPUT_BYTES = 134_217_728;

export type WorkerPriority = "current" | "background";
export type WorkerSliceMode = "active" | "idle";
export type WorkerWorkKind =
  | "source-digest"
  | "source-map-compose"
  | "persistence-encode"
  | "persistence-parse";

export interface WorkerRevision {
  readonly scene: number;
  readonly layout: number;
}

interface WorkerCancelRequest {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly kind: "cancel";
  readonly requestId: number;
}

export interface StructuredWorkRequest {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly kind: "process-structured";
  readonly requestId: number;
  readonly workKind: WorkerWorkKind;
  readonly revision: WorkerRevision;
  readonly byteLength: number;
  readonly maxOutputBytes: number;
  readonly scratchBytes: number;
  readonly payload: unknown;
}

export type WorkerRequest = StructuredWorkRequest | WorkerCancelRequest;

interface WorkerCancelledResponse {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly kind: "cancelled";
  readonly requestId: number;
}

interface WorkerStructuredCompleteResponse {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly kind: "structured-complete";
  readonly requestId: number;
  readonly revision: WorkerRevision;
  readonly byteLength: number;
  readonly payload: unknown;
}

interface WorkerErrorResponse {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly kind: "error";
  readonly requestId: number;
  readonly message?: string;
}

export type WorkerResponse =
  | WorkerStructuredCompleteResponse
  | WorkerCancelledResponse
  | WorkerErrorResponse;

export class WorkerQueueExhaustedError extends Error {
  public constructor(message = "The worker queue is exhausted.") {
    super(message);
    this.name = "WorkerQueueExhaustedError";
  }
}

export class WorkerCrashedError extends Error {
  public constructor(message = "The worker crashed.") {
    super(message);
    this.name = "WorkerCrashedError";
  }
}

export class StaleWorkerResultError extends Error {
  public constructor(message = "The worker result is stale.") {
    super(message);
    this.name = "StaleWorkerResultError";
  }
}

export class WorkerDisposedError extends Error {
  public constructor(message = "The worker scheduler is disposed.") {
    super(message);
    this.name = "WorkerDisposedError";
  }
}

export class WorkerRequestCancelledError extends Error {
  public constructor(message = "The worker request was cancelled.") {
    super(message);
    this.name = "AbortError";
  }
}
