import type { SceneRevision } from "../../domain/model";
import type {
  OperationId,
  HistoryEntryId,
  HistoryEpoch,
} from "../../domain/operations";
import type { RuntimeSceneStateV1 } from "../../domain/scene";

export type { HistoryEpoch } from "../../domain/operations";

export type CommandErrorCodeV1 =
  | "invalid-command"
  | "stale-scene"
  | "stale-source"
  | "stale-layout"
  | "history-unavailable"
  | "history-lease-unavailable"
  | "recovery-unavailable"
  | "recovery-limit"
  | "resource-limit"
  | "read-only-mode"
  | "sidecar-drift"
  | "sidecar-conflict"
  | "relocation-pending"
  | "disposed";

export type CommandResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: CommandErrorCodeV1 };

export type HostEffectId = string & { readonly __brand: "HostEffectId" };
export type RecoveryAttemptId = string & {
  readonly __brand: "RecoveryAttemptId";
};
export type SourceCheckpointId = string & {
  readonly __brand: "SourceCheckpointId";
};
export type RelocationId = string & { readonly __brand: "RelocationId" };
export type RemovalId = string & { readonly __brand: "RemovalId" };
export type ViewId = string & { readonly __brand: "ViewId" };
export type HostTransactionSequence = number & {
  readonly __brand: "HostTransactionSequence";
};
export type SessionOrder = number & { readonly __brand: "SessionOrder" };
export type SidecarRevision = number & {
  readonly __brand: "SidecarRevision";
};
export type SaveGeneration = number & { readonly __brand: "SaveGeneration" };
export type SourceGeneration = number & {
  readonly __brand: "SourceGeneration";
};
export type SettingsRevision = number & {
  readonly __brand: "SettingsRevision";
};
export type LayoutRevision = number & { readonly __brand: "LayoutRevision" };
export type Sha256Digest = string & { readonly __brand: "Sha256Digest" };

export interface NoteIdentityV1 {
  readonly vaultIdHint: string;
  readonly vaultRelativeMarkdownPath: string;
}

type SessionLifecycleV1 = "opening" | "ready" | "disposing" | "disposed";

type HistoryLeaseV1 =
  | { readonly kind: "unowned" }
  | {
      readonly kind: "owned";
      readonly ownerViewId: ViewId;
      readonly epoch: HistoryEpoch;
    }
  | {
      readonly kind: "closing";
      readonly ownerViewId: ViewId;
      readonly epoch: HistoryEpoch;
    }
  | { readonly kind: "blocked"; readonly reason: CommandErrorCodeV1 };

export type EffectiveViewAccessV1 =
  | { readonly kind: "mutable"; readonly epoch: HistoryEpoch }
  | { readonly kind: "secondary-read-only"; readonly ownerViewId: ViewId }
  | { readonly kind: "reading-read-only" }
  | { readonly kind: "blocked"; readonly reason: CommandErrorCodeV1 };

export interface FirstSidecarPendingV1 {
  readonly noteIdentity: NoteIdentityV1;
  readonly operationId: OperationId;
  readonly historyEntryId: HistoryEntryId;
  readonly recoveryAttemptId: RecoveryAttemptId;
  readonly expectedVaultRelativePath: string;
  readonly expectedSettingsRevision: SettingsRevision;
  readonly expectedSourceGeneration: SourceGeneration;
  readonly expectedSourceDigest: Sha256Digest;
}

type PersistenceStateV1 =
  | { readonly kind: "unannotated" }
  | {
      readonly kind: "first-sidecar-pending";
      readonly pending: FirstSidecarPendingV1;
    }
  | { readonly kind: "clean"; readonly sidecarRevision: SidecarRevision }
  | { readonly kind: "dirty"; readonly generation: SaveGeneration }
  | { readonly kind: "saving"; readonly generation: SaveGeneration }
  | { readonly kind: "conflict" }
  | { readonly kind: "drift" }
  | { readonly kind: "relocating"; readonly relocationId: RelocationId }
  | { readonly kind: "newer-version" };

type SourceStateV1 =
  | {
      readonly kind: "durable";
      readonly generation: SourceGeneration;
      readonly digest: Sha256Digest;
    }
  | {
      readonly kind: "checkpoint-pending";
      readonly generation: SourceGeneration;
    }
  | { readonly kind: "reattaching"; readonly targetDigest: Sha256Digest };

export interface NoteSessionSnapshotV1 {
  readonly lifecycle: SessionLifecycleV1;
  readonly historyLease: HistoryLeaseV1;
  readonly persistence: PersistenceStateV1;
  readonly source: SourceStateV1;
  readonly scene: RuntimeSceneStateV1;
}

export interface CommandViewV1 {
  readonly viewId: ViewId;
  readonly mode: "editable" | "reading";
  readonly layoutRevision: LayoutRevision;
  readonly historyAvailable: boolean;
  readonly prospectiveHistoryEpoch: HistoryEpoch | null;
}

export interface AnnotationCommandRequestV1 {
  readonly operationId: OperationId;
  readonly historyEntryId: HistoryEntryId;
  readonly recoveryAttemptId: RecoveryAttemptId;
  readonly expectedSceneRevision: SceneRevision;
  readonly expectedSourceGeneration: SourceGeneration;
  readonly expectedSourceDigest: Sha256Digest;
  readonly expectedLayoutRevision: LayoutRevision;
  readonly recoveryAvailable: boolean;
  readonly firstSidecarExpectation: FirstSidecarCommandExpectationV1 | null;
}

interface FirstSidecarCommandExpectationV1 {
  readonly noteIdentity: NoteIdentityV1;
  readonly expectedVaultRelativePath: string;
  readonly expectedSettingsRevision: SettingsRevision;
}

export interface CommandAdmissionTokenV1 {
  readonly operationId: OperationId;
  readonly historyEntryId: HistoryEntryId;
  readonly recoveryAttemptId: RecoveryAttemptId;
  readonly viewId: ViewId;
  readonly historyEpoch: HistoryEpoch;
  readonly sceneRevision: SceneRevision;
  readonly sourceGeneration: SourceGeneration;
  readonly sourceDigest: Sha256Digest;
  readonly layoutRevision: LayoutRevision;
  readonly firstSidecarExpectation: FirstSidecarCommandExpectationV1 | null;
}

export interface CommandRevalidationContextV1 {
  readonly recoveryAvailable: boolean;
}

export interface HostEffectEnvelopeV1 {
  readonly effectId: HostEffectId;
  readonly noteIdentity: NoteIdentityV1;
  readonly historyEpoch: HistoryEpoch;
  readonly historyEntryId: HistoryEntryId;
  readonly direction: "forward" | "inverse";
}

export interface HostEffectDeliveryV1 {
  readonly envelope: HostEffectEnvelopeV1;
  readonly transactionSequence: HostTransactionSequence;
}

export type HostEffectLifecycleV1 = "admitting" | "applied" | "undone";
