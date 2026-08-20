export const WORKER_PROTOCOL_VERSION = 1 as const;
export const MAX_WORKER_REQUEST_BYTES = 1_048_576;
export const WORKER_CHUNK_BYTES = 16_384;
export const ACTIVE_WORKER_SLICE_MS = 2;
export const IDLE_WORKER_SLICE_MS = 4;

export type WorkerPriority = "current" | "background";
export type WorkerSliceMode = "active" | "idle";

export interface WorkerRevision {
  readonly scene: number;
  readonly layout: number;
}

export interface ByteWorkRequest {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly kind: "process";
  readonly requestId: number;
  readonly revision: WorkerRevision;
  readonly byteLength: number;
  readonly chunkBytes: number;
  readonly payload: ArrayBuffer;
}

interface WorkerCancelRequest {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly kind: "cancel";
  readonly requestId: number;
}

export type ByteWorkerRequest = ByteWorkRequest | WorkerCancelRequest;

interface WorkerCompleteResponse {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly kind: "complete";
  readonly requestId: number;
  readonly revision: WorkerRevision;
  readonly byteLength: number;
  readonly payload: ArrayBuffer;
}

interface WorkerCancelledResponse {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly kind: "cancelled";
  readonly requestId: number;
}

interface WorkerErrorResponse {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly kind: "error";
  readonly requestId: number;
  readonly message?: string;
}

export type ByteWorkerResponse =
  WorkerCompleteResponse | WorkerCancelledResponse | WorkerErrorResponse;

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
