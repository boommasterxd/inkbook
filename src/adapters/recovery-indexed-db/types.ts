import type { ResourceCoordinatorV1 } from "../../application/resource-coordinator";

/* Recovery budgets are normative binary-megabyte contract values. */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
export const DEFAULT_GLOBAL_BYTE_LIMIT = 32 * 1024 * 1024;
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
export const DEFAULT_NOTE_BYTE_LIMIT = 8 * 1024 * 1024;

export interface RecoveryNoteKey {
  readonly vaultIdentityHint: string;
  readonly markdownPath: string;
}

export interface PreparedForwardProbeRecord {
  readonly schemaVersion: 1;
  readonly kind: "prepared-forward";
  readonly note: RecoveryNoteKey;
  readonly attemptId: string;
  readonly sessionOrder: number;
  readonly forwardPatch: string;
  readonly inversePatch: string;
}

export interface HostAcknowledgementProbe {
  readonly editorViewId: string;
  readonly effectId: string;
  readonly direction: "forward" | "inverse";
  readonly transactionSequence: number;
}

export interface HostRecordedForwardProbeRecord {
  readonly schemaVersion: 1;
  readonly kind: "host-recorded-forward";
  readonly note: RecoveryNoteKey;
  readonly attemptId: string;
  readonly sessionOrder: number;
  readonly acknowledgement: HostAcknowledgementProbe;
  readonly forwardPatch: string;
  readonly inversePatch: string;
}

interface HostRecordedDirectionProbeRecord {
  readonly schemaVersion: 1;
  readonly kind: "host-recorded-undo" | "host-recorded-redo";
  readonly note: RecoveryNoteKey;
  readonly attemptId: string;
  readonly sessionOrder: number;
  readonly acknowledgement: HostAcknowledgementProbe;
  readonly forwardPatch: string;
  readonly inversePatch: string;
}

export type RecoveryProbeRecord =
  | PreparedForwardProbeRecord
  | HostRecordedForwardProbeRecord
  | HostRecordedDirectionProbeRecord;

export interface RecordForwardRequest {
  readonly note: RecoveryNoteKey;
  readonly attemptId: string;
  readonly expectedSessionOrder: number;
  readonly acknowledgement: HostAcknowledgementProbe;
}

export type RecordDirectionRequest = HostRecordedDirectionProbeRecord;

export interface DeleteAttemptRequest {
  readonly note: RecoveryNoteKey;
  readonly attemptId: string;
}

export interface RecoveryByteUsage {
  readonly globalBytes: number;
  readonly noteBytes: number;
}

export type RecoveryMutationResult =
  | { readonly kind: "written"; readonly byteUsage: RecoveryByteUsage }
  | { readonly kind: "unchanged"; readonly byteUsage: RecoveryByteUsage }
  | RecoveryOperationFailure;

export type RecoveryDeleteResult =
  | { readonly kind: "deleted"; readonly byteUsage: RecoveryByteUsage }
  | { readonly kind: "not-found"; readonly byteUsage: RecoveryByteUsage }
  | RecoveryOperationFailure;

export type RecoveryLoadResult =
  | {
      readonly kind: "loaded";
      readonly records: readonly RecoveryProbeRecord[];
      releaseResources(): boolean;
    }
  | { readonly kind: "corrupt"; readonly recordKey: string }
  | RecoveryOperationFailure;

export type RecoveryOperationFailure =
  | { readonly kind: "backend-unavailable" }
  | { readonly kind: "concurrent-change" }
  | { readonly kind: "disposed" }
  | { readonly kind: "invalid-input" }
  | { readonly kind: "quota-exceeded" }
  | { readonly kind: "resource-limited" }
  | { readonly kind: "transaction-aborted" };

export interface RecoveryIndexedDbFaultInjector {
  beforeExecute?(
    operation: "prepare" | "record" | "direction" | "load" | "usage" | "delete",
  ): Promise<void>;
  beforeCommit(
    operation: "prepare" | "record" | "direction" | "delete",
    transaction: IDBTransaction,
  ): void;
}

export interface RecoveryIndexedDbOptions {
  readonly indexedDb?: IDBFactory | undefined;
  readonly databaseName?: string | undefined;
  readonly globalByteLimit?: number | undefined;
  readonly noteByteLimit?: number | undefined;
  readonly faultInjector?: RecoveryIndexedDbFaultInjector | undefined;
  readonly resourceCoordinator: ResourceCoordinatorV1;
}

export type RecoveryProbeFailureReason =
  | "backend-unavailable"
  | "non-transactional"
  | "resource-limited"
  | "schema-incompatible";

interface RecoveryReadOnlyProbeResult {
  readonly kind: "read-only";
  readonly reason: RecoveryProbeFailureReason;
}

interface RecoveryReadyProbeResult {
  readonly kind: "ready";
  readonly store: RecoveryIndexedDbStore;
}

export type RecoveryIndexedDbProbeResult =
  RecoveryReadOnlyProbeResult | RecoveryReadyProbeResult;

export interface RecoveryIndexedDbStore {
  prepareForward(
    record: PreparedForwardProbeRecord,
  ): Promise<RecoveryMutationResult>;
  recordForward(request: RecordForwardRequest): Promise<RecoveryMutationResult>;
  recordDirection(
    record: RecordDirectionRequest,
  ): Promise<RecoveryMutationResult>;
  loadNote(note: RecoveryNoteKey): Promise<RecoveryLoadResult>;
  deleteAttempt(request: DeleteAttemptRequest): Promise<RecoveryDeleteResult>;
  getByteUsage(
    note: RecoveryNoteKey,
  ): Promise<RecoveryByteUsage | RecoveryOperationFailure>;
  dispose(): Promise<void>;
}
