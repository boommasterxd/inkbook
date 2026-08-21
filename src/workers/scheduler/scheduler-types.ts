import type { LaunchedBrowserWorker } from "./browser-worker-adapter";
import type {
  WorkerPriority,
  WorkerRevision,
  WorkerSliceMode,
  WorkerWorkKind,
} from "./protocol";
import type { WorkerWorkBounds } from "./work-profiles";

interface WorkerClock {
  now(): number;
}

export interface WorkerSliceScheduler {
  schedule(mode: WorkerSliceMode, callback: () => void): () => void;
}

export interface WorkerFallbackProcessor<TResult = Uint8Array<ArrayBuffer>> {
  /** Performs one bounded unit and reports whether all pure work is complete. */
  processNext(): boolean;
  /** Returns already materialized output without performing more pure work. */
  complete(): TResult;
  dispose?(): void;
}

export interface ByteWorkerSchedulerOptions {
  readonly launchWorker: () => LaunchedBrowserWorker | undefined;
  readonly clock: WorkerClock;
  readonly slices: WorkerSliceScheduler;
  readonly isCurrent: (revision: WorkerRevision) => boolean;
  readonly maxOutstandingRequests?: number;
  readonly maxOutstandingBytes?: number;
  readonly maxReservedBytes?: number;
}

export interface StructuredWorkerSubmission<TResult> {
  readonly result: Promise<TResult>;
  cancel(): void;
}

export interface StructuredWorkerWork<TResult> extends WorkerWorkBounds {
  readonly kind: WorkerWorkKind;
  readonly payload: unknown;
  readonly inputBytes: number;
  readonly revision: WorkerRevision;
  readonly priority: WorkerPriority;
  readonly mode: WorkerSliceMode;
  readonly createFallbackProcessor: () => WorkerFallbackProcessor<TResult>;
  readonly normalizeResult: (value: unknown) => TResult;
  readonly workerFirst?: boolean;
}

export interface TaskInput {
  readonly workKind: WorkerWorkKind;
  readonly revision: WorkerRevision;
  readonly priority: WorkerPriority;
  readonly mode: WorkerSliceMode;
  readonly maxOutputBytes: number;
  readonly scratchBytes: number;
  readonly workerFirst: boolean;
  readonly inputBytes: number;
  readonly structuredPayload: unknown;
  readonly normalizeStructuredResult: (value: unknown) => unknown;
  readonly fallbackProcessorFactory: () => WorkerFallbackProcessor<unknown>;
}

export interface PendingTask extends TaskInput {
  readonly id: number;
  readonly byteLength: number;
  readonly reservedBytes: number;
  readonly promise: Promise<unknown>;
  readonly resolve: (result: unknown) => void;
  readonly reject: (reason: Error) => void;
  cancelled: boolean;
  fallbackProcessor?: WorkerFallbackProcessor<unknown>;
  sentToWorker: boolean;
}
