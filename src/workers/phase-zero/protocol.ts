export const PHASE_ZERO_PROTOCOL_VERSION = 1 as const;
export const PHASE_ZERO_MAX_REQUEST_BYTES = 1_048_576;
export const PHASE_ZERO_CHUNK_BYTES = 16_384;
export const PHASE_ZERO_ACTIVE_SLICE_MS = 2;
export const PHASE_ZERO_IDLE_SLICE_MS = 4;

export type PhaseZeroPriority = "current" | "background";
export type PhaseZeroSliceMode = "active" | "idle";

export interface PhaseZeroRevision {
  readonly scene: number;
  readonly layout: number;
}

export interface PhaseZeroRequest {
  readonly protocolVersion: typeof PHASE_ZERO_PROTOCOL_VERSION;
  readonly kind: "transform";
  readonly requestId: number;
  readonly revision: PhaseZeroRevision;
  readonly byteLength: number;
  readonly chunkBytes: number;
  readonly payload: ArrayBuffer;
}

interface PhaseZeroCancelRequest {
  readonly protocolVersion: typeof PHASE_ZERO_PROTOCOL_VERSION;
  readonly kind: "cancel";
  readonly requestId: number;
}

export type PhaseZeroWorkerRequest = PhaseZeroRequest | PhaseZeroCancelRequest;

interface PhaseZeroCompleteResponse {
  readonly protocolVersion: typeof PHASE_ZERO_PROTOCOL_VERSION;
  readonly kind: "complete";
  readonly requestId: number;
  readonly revision: PhaseZeroRevision;
  readonly byteLength: number;
  readonly payload: ArrayBuffer;
}

interface PhaseZeroCancelledResponse {
  readonly protocolVersion: typeof PHASE_ZERO_PROTOCOL_VERSION;
  readonly kind: "cancelled";
  readonly requestId: number;
}

interface PhaseZeroErrorResponse {
  readonly protocolVersion: typeof PHASE_ZERO_PROTOCOL_VERSION;
  readonly kind: "error";
  readonly requestId: number;
  readonly message?: string;
}

export type PhaseZeroWorkerResponse =
  | PhaseZeroCompleteResponse
  | PhaseZeroCancelledResponse
  | PhaseZeroErrorResponse;

export class WorkerQueueExhaustedError extends Error {
  public constructor(message = "The phase-zero worker queue is exhausted.") {
    super(message);
    this.name = "WorkerQueueExhaustedError";
  }
}

export class WorkerCrashedError extends Error {
  public constructor(message = "The phase-zero worker crashed.") {
    super(message);
    this.name = "WorkerCrashedError";
  }
}

export class StaleWorkerResultError extends Error {
  public constructor(message = "The phase-zero worker result is stale.") {
    super(message);
    this.name = "StaleWorkerResultError";
  }
}

export class WorkerDisposedError extends Error {
  public constructor(message = "The phase-zero worker scheduler is disposed.") {
    super(message);
    this.name = "WorkerDisposedError";
  }
}

export class WorkerRequestCancelledError extends Error {
  public constructor(message = "The phase-zero worker request was cancelled.") {
    super(message);
    this.name = "AbortError";
  }
}
