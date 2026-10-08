import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type {
  DocumentRuntimeObserver,
  DocumentRuntimeRequest,
  DocumentRuntimeResult,
} from "./types";
import type { RequestWatchdog } from "./request-timeout";
import type { ScenePathReceiver } from "./scene-path-receiver";

export interface PendingBridgeRequest {
  readonly sceneReceiver: ScenePathReceiver;
  readonly acceptsUnlockBatches: boolean;
  adoptedElementCount: number;
  readonly abortController: AbortController;
  batchAdoptionPending: boolean;
  nextUnlockBatchIndex: number;
  readonly observer: DocumentRuntimeObserver | undefined;
  readonly reject: (error: Error) => void;
  readonly request: DocumentRuntimeRequest;
  resultAdoptionPending: boolean;
  readonly resolve: (result: DocumentRuntimeResult) => void;
  cancelTimeout: (() => void) | undefined;
  watchdog?: RequestWatchdog;
}

export interface WorkerBridgeEndpoint {
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  removeEventListener(type: "error", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  terminate(): void;
}

export interface WorkerRuntimeFailure {
  readonly kind: "error" | "protocol" | "timeout";
  readonly errorName?:
    | "Error"
    | "TypeError"
    | "RangeError"
    | "SyntaxError"
    | "DataCloneError"
    | "SecurityError"
    | "AbortError"
    | "NotSupportedError";
  readonly phase:
    | "construction"
    | "dispatch"
    | "host-decoding"
    | "host-execution"
    | "host-encoding"
    | "adoption"
    | "timeout"
    | "worker-event";
  readonly request?: DocumentRuntimeRequest;
}

export interface WorkerDocumentRuntimePortOptions {
  readonly workScheduler: WorkScheduler;
  readonly onExecutorFailure?: (failure: WorkerRuntimeFailure) => void;
  readonly frameIntervalMilliseconds: () => number;
  readonly requestTimeoutMilliseconds?: number;
  readonly requestTimeoutNow?: () => number;
  readonly scheduleRequestTimeout?: (callback: () => void, milliseconds: number) => () => void;
  readonly subscribeSchedulingProfile?: (listener: () => void) => () => void;
}
