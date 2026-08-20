/**
 * Sanitized, framework-independent status records for persistence workflows.
 * These records deliberately contain no note, file, path, or diagnostic data.
 */

export type PersistenceStatusV1 =
  | { readonly kind: "unannotated" }
  | { readonly kind: "first-sidecar-pending" }
  | { readonly kind: "clean"; readonly sidecarRevision: number }
  | { readonly kind: "dirty"; readonly generation: number }
  | { readonly kind: "saving"; readonly generation: number }
  | { readonly kind: "conflict" }
  | { readonly kind: "drift" }
  | { readonly kind: "relocating" }
  | { readonly kind: "newer-version" };

export type ConflictStatusV1 =
  | { readonly kind: "none" }
  | { readonly kind: "sidecar-changed" }
  | { readonly kind: "source-changed" }
  | { readonly kind: "location-collision"; readonly copyCount: number }
  | { readonly kind: "recovery-conflict" }
  | { readonly kind: "relocation-conflict" };

export type DriftStatusV1 =
  | { readonly kind: "none" }
  | { readonly kind: "marker-present-sidecar-missing" }
  | { readonly kind: "sidecar-present-marker-missing" }
  | { readonly kind: "marker-invalid" }
  | { readonly kind: "sidecar-renamed" }
  | { readonly kind: "sidecar-deleted" }
  | { readonly kind: "source-changed" };

type RelocationScopeV1 = "note" | "folder" | "storage-root";

export type RelocationStatusV1 =
  | { readonly kind: "none" }
  | {
      readonly kind: "relocating";
      readonly scope: RelocationScopeV1;
      readonly completedSteps: number;
      readonly totalSteps: number;
    }
  | { readonly kind: "complete"; readonly scope: RelocationScopeV1 }
  | { readonly kind: "conflict"; readonly scope: RelocationScopeV1 }
  | { readonly kind: "failed"; readonly scope: RelocationScopeV1 };

type RecoveryUnavailableReasonV1 = "backend" | "quota" | "corrupt" | "disposed";

type RecoveryLimitV1 = "bytes" | "records" | "successors";

export type RecoveryStatusV1 =
  | { readonly kind: "none" }
  | {
      readonly kind: "available";
      readonly bytesUsed: number;
      readonly recordCount: number;
    }
  | {
      readonly kind: "pending";
      readonly bytesUsed: number;
      readonly recordCount: number;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: RecoveryUnavailableReasonV1;
    }
  | { readonly kind: "limited"; readonly limit: RecoveryLimitV1 }
  | { readonly kind: "conflict" }
  | { readonly kind: "reattachment-required" };

export type ResourceKindV1 =
  | "recovery-bytes"
  | "recovery-records"
  | "recovery-successors"
  | "persistence-pipelines"
  | "queue-turns"
  | "sessions"
  | "conflict-copies";

export type ResourceLimitStatusV1 =
  | { readonly kind: "within-limit" }
  | {
      readonly kind: "limited";
      readonly resource: ResourceKindV1;
      readonly used: number;
      readonly limit: number;
    };

type RetryActionV1 =
  | "save"
  | "marker"
  | "recovery"
  | "relocation"
  | "reload"
  | "conflict-copy"
  | "removal";

export type RetryStatusV1 =
  | { readonly kind: "not-required" }
  | {
      readonly kind: "available";
      readonly action: RetryActionV1;
      readonly attemptCount: number;
    }
  | {
      readonly kind: "exhausted";
      readonly action: RetryActionV1;
      readonly attemptCount: number;
    };

export interface StatusSnapshotV1 {
  readonly persistence: PersistenceStatusV1;
  readonly conflict: ConflictStatusV1;
  readonly drift: DriftStatusV1;
  readonly relocation: RelocationStatusV1;
  readonly recovery: RecoveryStatusV1;
  readonly resourceLimit: ResourceLimitStatusV1;
  readonly retry: RetryStatusV1;
}

type StatusValidationCodeV1 = "invalid-status";

export type StatusValidationResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: StatusValidationCodeV1 };
