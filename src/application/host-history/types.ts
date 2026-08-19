export type HistoryEntryId = string & { readonly __brand: "HistoryEntryId" };
export type HostEffectId = string & { readonly __brand: "HostEffectId" };
export type OperationId = string & { readonly __brand: "OperationId" };
export type ViewId = string & { readonly __brand: "ViewId" };
export type HistoryEpoch = number & { readonly __brand: "HistoryEpoch" };
export type HostTransactionSequence = number & {
  readonly __brand: "HostTransactionSequence";
};

export interface NoteIdentityV1 {
  readonly vaultIdHint: string;
  readonly vaultRelativeMarkdownPath: string;
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

type HostEffectLifecycleV1 = "admitting" | "applied" | "undone";

export interface ProbeAnnotationPatchV1 {
  readonly prior: string | null;
  readonly replacement: string | null;
}

export interface ProbeSceneSnapshotV1 {
  readonly annotation: string | null;
  readonly revision: number;
}

export interface HostDispatchIntentV1 {
  readonly operationId: OperationId;
  readonly historyEntryId: HistoryEntryId;
  readonly historyEpoch: HistoryEpoch;
  readonly direction: "forward" | "undo" | "redo";
  readonly expectedSceneRevision: number;
  readonly patch: ProbeAnnotationPatchV1;
}

export interface HostEffectAcknowledgementV1 {
  readonly editorViewId: ViewId;
  readonly ownerViewId: ViewId;
  readonly effectId: HostEffectId;
  readonly direction: "forward" | "inverse";
  readonly transactionSequence: HostTransactionSequence;
}

export interface HostEffectRecoveryPortV1 {
  record(
    intent: HostDispatchIntentV1,
    acknowledgement: HostEffectAcknowledgementV1,
  ): Promise<boolean>;
}

export interface HostHistoryLimitsV1 {
  readonly maxActionableEntries: number;
  readonly maxPayloadBytes: number;
}

export interface PrepareHostEffectRequestV1 {
  readonly viewId: ViewId;
  readonly effectId: HostEffectId;
  readonly historyEntryId: HistoryEntryId;
  readonly patch: ProbeAnnotationPatchV1;
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
  | "invalid-patch"
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
      readonly scene: ProbeSceneSnapshotV1;
    }
  | {
      readonly kind: "duplicate";
      readonly intent: HostDispatchIntentV1;
      readonly scene: ProbeSceneSnapshotV1;
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
  readonly historyEntryId: HistoryEntryId;
  readonly ownerViewId: ViewId;
  readonly historyEpoch: HistoryEpoch;
  readonly lifecycle: HostEffectLifecycleV1;
  readonly patch: ProbeAnnotationPatchV1;
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
  readonly scene: ProbeSceneSnapshotV1;
  readonly lease: HostHistoryLeaseSnapshotV1;
  readonly nextEpoch: number;
  readonly entries: readonly ActionableHistoryEntrySnapshotV1[];
  readonly acceptedDeliveries: readonly AcceptedDeliverySnapshotV1[];
  readonly highWaterMarks: readonly EditorEpochHighWaterSnapshotV1[];
}

export interface HostHistoryCoordinatorConfigV1 {
  readonly noteIdentity: NoteIdentityV1;
  readonly initialAnnotation: string | null;
  readonly createOperationId: () => OperationId;
  readonly recovery: HostEffectRecoveryPortV1;
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
