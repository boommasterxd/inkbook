import type {
  AnnotationHistoryEntryV1,
  AnnotationOperationV1,
  HistoryEpoch,
  OperationId,
} from "../../domain/operations";
import type { AnnotationDependencyIndexV1 } from "../../domain/operations";
import type { RuntimeSceneStateV1 } from "../../domain/scene";
import type {
  HostAcknowledgementV1,
  RecoveryStore,
  SidecarBaseIdentityV1,
} from "../recovery";
import type {
  HostEffectEnvelopeV1,
  HostEffectId,
  HostEffectLifecycleV1,
  HostTransactionSequence,
  NoteIdentityV1,
  RecoveryAttemptId,
  SessionOrder,
  Sha256Digest,
  SourceGeneration,
  ViewId,
} from "../note-session";

export type { HistoryEntryId, HistoryEpoch } from "../../domain/operations";
export type {
  HostEffectDeliveryV1,
  HostEffectEnvelopeV1,
  HostEffectId,
  HostTransactionSequence,
  NoteIdentityV1,
  ViewId,
} from "../note-session";

export type HostDispatchIntentV1 = AnnotationOperationV1;

export interface HostHistoryRecoveryContextV1 {
  readonly base: SidecarBaseIdentityV1;
  readonly expectedSourceGeneration: SourceGeneration;
  readonly expectedSourceDigest: Sha256Digest;
  readonly createRecoveryAttemptId: () => RecoveryAttemptId;
  readonly nextSessionOrder: () => SessionOrder;
}

export interface HostHistoryLimitsV1 {
  readonly maxActionableEntries: number;
  readonly maxPayloadBytes: number;
}

export interface PrepareHostEffectRequestV1 {
  readonly viewId: ViewId;
  readonly effectId: HostEffectId;
  readonly operationId: OperationId;
  readonly historyEntry: AnnotationHistoryEntryV1;
}

export type PrepareHostEffectResultV1 =
  | {
      readonly kind: "prepared";
      readonly envelope: HostEffectEnvelopeV1;
      readonly intent: HostDispatchIntentV1;
    }
  | { readonly kind: "rejected"; readonly reason: HostHistoryFailureV1 };

export type HostHistoryFailureV1 =
  | "blocked"
  | "disposed"
  | "duplicate-identity"
  | "entry-not-found"
  | "invalid-envelope"
  | "invalid-operation"
  | "invalid-sequence"
  | "lifecycle-mismatch"
  | "non-owner"
  | "out-of-order"
  | "payload-limit"
  | "pending-admission"
  | "recovery-failed"
  | "revision-mismatch"
  | "stale-epoch"
  | "stale-sequence"
  | "unrestorable-history";

export type HostEffectDeliveryResultV1 =
  | {
      readonly kind: "accepted";
      readonly intent: HostDispatchIntentV1;
      readonly scene: RuntimeSceneStateV1;
    }
  | {
      readonly kind: "duplicate";
      readonly intent: HostDispatchIntentV1;
      readonly scene: RuntimeSceneStateV1;
    }
  | { readonly kind: "rejected"; readonly reason: HostHistoryFailureV1 };

export type HostHistoryLeaseSnapshotV1 =
  | { readonly kind: "unowned" }
  | {
      readonly kind: "owned";
      readonly ownerViewId: ViewId;
      readonly epoch: HistoryEpoch;
    }
  | { readonly kind: "blocked"; readonly reason: HostHistoryFailureV1 };

export interface ActionableHistoryEntrySnapshotV1 {
  readonly effectId: HostEffectId;
  readonly ownerViewId: ViewId;
  readonly historyEntry: AnnotationHistoryEntryV1;
  readonly lifecycle: HostEffectLifecycleV1;
  readonly recoveryAttemptId: RecoveryAttemptId;
  readonly preparedForward: HostDispatchIntentV1;
}

export interface AcceptedDeliverySnapshotV1 {
  readonly editorViewId: ViewId;
  readonly historyEpoch: HistoryEpoch;
  readonly sequence: HostTransactionSequence;
  readonly envelope: HostEffectEnvelopeV1;
  readonly intent: HostDispatchIntentV1;
}

export interface EditorEpochHighWaterSnapshotV1 {
  readonly editorViewId: ViewId;
  readonly historyEpoch: HistoryEpoch;
  readonly sequence: HostTransactionSequence;
}

export interface HostHistorySnapshotV1 {
  readonly version: 1;
  readonly noteIdentity: NoteIdentityV1;
  readonly scene: RuntimeSceneStateV1;
  readonly lease: HostHistoryLeaseSnapshotV1;
  readonly nextEpoch: number;
  readonly entries: readonly ActionableHistoryEntrySnapshotV1[];
  readonly acceptedDeliveries: readonly AcceptedDeliverySnapshotV1[];
  readonly highWaterMarks: readonly EditorEpochHighWaterSnapshotV1[];
}

export interface HostHistoryCoordinatorConfigV1 {
  readonly noteIdentity: NoteIdentityV1;
  readonly initialScene: RuntimeSceneStateV1;
  readonly initialDependencies?: AnnotationDependencyIndexV1;
  readonly createOperationId: () => OperationId;
  readonly recovery: RecoveryStore;
  readonly recoveryContext:
    HostHistoryRecoveryContextV1 | (() => HostHistoryRecoveryContextV1);
  readonly limits?: Partial<HostHistoryLimitsV1>;
  readonly onRelease?: (entry: ActionableHistoryEntrySnapshotV1) => void;
}

export interface HostHistoryRestoreOptionsV1 {
  readonly hostEffectsMayBeReachable: boolean;
  readonly snapshot?: HostHistorySnapshotV1;
}

export type HostHistoryDisposalResultV1 =
  | { readonly kind: "disposed-unreachable" }
  | { readonly kind: "snapshot"; readonly snapshot: HostHistorySnapshotV1 }
  | { readonly kind: "blocked"; readonly reason: HostHistoryFailureV1 };

export type HostEffectAcknowledgementV1 = HostAcknowledgementV1;
