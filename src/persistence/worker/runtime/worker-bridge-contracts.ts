import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { DocumentRuntimeRequest } from "./types";

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
  readonly request?: DocumentRuntimeRequest;
}

export interface WorkerDocumentRuntimePortOptions {
  readonly workScheduler: WorkScheduler;
  readonly onExecutorFailure?: (failure: WorkerRuntimeFailure) => void;
  readonly frameIntervalMilliseconds: () => number;
  readonly requestTimeoutMilliseconds?: number;
  readonly subscribeSchedulingProfile?: (listener: () => void) => () => void;
}
