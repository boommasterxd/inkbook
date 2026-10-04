import type {
  DocumentRuntimeWireRequest,
  DocumentRuntimeWireResult,
  DocumentRuntimeWireUnlockBatch,
} from "./wire-codec";

export interface BridgeRequest {
  readonly request: DocumentRuntimeWireRequest;
  readonly requestId: number;
  readonly type: "inkbook-worker-request";
}

export interface BridgeSuccess {
  readonly requestId: number;
  readonly result: DocumentRuntimeWireResult;
  readonly type: "inkbook-worker-result";
}

export interface BridgeFailure {
  readonly code: "executor-failed";
  readonly requestId: number;
  readonly type: "inkbook-worker-error";
}

export interface BridgeUnlockBatch {
  readonly batch: DocumentRuntimeWireUnlockBatch;
  readonly requestId: number;
  readonly type: "inkbook-worker-unlock-batch";
}

export interface BridgeScenePaths {
  readonly batch: import("./types").PreparedScenePathsRuntimeSuccess;
  readonly batchIndex: number;
  readonly requestId: number;
  readonly type: "inkbook-worker-scene-paths";
}

export interface BridgeBatchAcknowledgement {
  readonly accepted: boolean;
  readonly batchIndex: number;
  readonly requestId: number;
  readonly type: "inkbook-worker-batch-acknowledgement";
}

export interface BridgeExportAcknowledgement {
  readonly accepted: boolean;
  readonly exportGeneration: number;
  readonly modelRevision: number;
  readonly requestId: number;
  readonly sessionId: string;
  readonly type: "inkbook-worker-export-acknowledgement";
  readonly workerEpoch: number;
}

export interface BridgeControl {
  readonly action:
    | "cancel-scene-paths"
    | "retarget-scene-paths"
    | "prewarm"
    | "set-live-input"
    | "set-navigation"
    | "set-profile";
  readonly ids?: readonly string[];
  readonly identity?: import("../protocol").PurposeOperationIdentity;
  readonly active?: boolean;
  readonly frameIntervalMilliseconds?: number;
  readonly sliceMilliseconds?: number;
  readonly type: "inkbook-worker-control";
}

export type BridgeResponse = BridgeFailure | BridgeSuccess | BridgeUnlockBatch | BridgeScenePaths;
