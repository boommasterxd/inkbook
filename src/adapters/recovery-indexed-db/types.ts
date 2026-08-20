import type { RecoveryStore } from "../../application/recovery";

export interface IndexedDbRecoveryLimits {
  readonly globalBytes: number;
  readonly noteBytes: number;
  readonly globalRecords: number;
  readonly noteRecords: number;
  readonly directSuccessors: number;
  readonly queuedBytes: number;
  readonly queuedOperations: number;
}

export type RecoveryMutationKind =
  | "prepare-forward"
  | "record-forward"
  | "append-direction"
  | "append-checkpoint"
  | "acknowledge-sidecar"
  | "begin-relocation"
  | "begin-prefix-relocation-batch"
  | "advance-relocation"
  | "begin-removal"
  | "advance-removal"
  | "complete-saga"
  | "discard-confirmed-note-recovery"
  | "finalize-removal-recovery"
  | "prepare-prefix-relocation-plan"
  | "remove-retained-prefix-relocation-rule"
  | "rekey-note";

export interface IndexedDbRecoveryFaultInjector {
  beforeCommit(
    operation: RecoveryMutationKind,
    transaction: IDBTransaction,
  ): void;
}

export interface IndexedDbRecoveryOptions {
  readonly indexedDb?: IDBFactory | undefined;
  readonly databaseName?: string | undefined;
  readonly limits?: Partial<IndexedDbRecoveryLimits> | undefined;
  readonly faultInjector?: IndexedDbRecoveryFaultInjector | undefined;
}

export type IndexedDbRecoveryOpenResult =
  | { readonly ok: true; readonly value: RecoveryStore }
  | { readonly ok: false; readonly code: "recovery-unavailable" };

export interface RecoveryAccounting {
  readonly bytes: number;
  readonly records: number;
  readonly sessionOrderHighWater: number;
  readonly prefixGenerationHighWater: number;
}
