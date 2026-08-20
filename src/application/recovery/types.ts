import type { SceneRevision } from "../../domain/model";
import type {
  AnnotationPatchV1,
  HistoryEntryId,
  OperationId,
} from "../../domain/operations";
import type {
  HistoryEpoch,
  HostEffectId,
  HostTransactionSequence,
  NoteIdentityV1,
  RecoveryAttemptId,
  RelocationId,
  RemovalId,
  SessionOrder,
  SettingsRevision,
  Sha256Digest,
  SidecarRevision,
  SourceCheckpointId,
  SourceGeneration,
  ViewId,
} from "../note-session/types";
import type { SourceCheckpointOperationV1 } from "../source-coordination/types";
import type { SidecarBaseIdentityV1 } from "./base";

export interface RecoveryAttemptCommonV1 {
  readonly attemptId: RecoveryAttemptId;
  readonly operationId: OperationId;
  readonly historyEntryId: HistoryEntryId;
  readonly historyEpoch: HistoryEpoch;
  readonly sessionOrder: SessionOrder;
  readonly base: SidecarBaseIdentityV1;
  readonly expectedSceneRevision: SceneRevision;
  readonly expectedSourceGeneration: SourceGeneration;
  readonly expectedSourceDigest: Sha256Digest;
}

export interface HostAcknowledgementV1 {
  readonly editorViewId: ViewId;
  readonly effectId: HostEffectId;
  readonly direction: "forward" | "inverse";
  readonly transactionSequence: HostTransactionSequence;
}

export interface PreparedForwardAttemptV1 extends RecoveryAttemptCommonV1 {
  readonly kind: "prepared-forward";
  readonly forward: AnnotationPatchV1;
  readonly inverse: AnnotationPatchV1;
}

export interface HostRecordedForwardAttemptV1 extends RecoveryAttemptCommonV1 {
  readonly kind: "host-recorded-forward";
  readonly acknowledgement: HostAcknowledgementV1;
  readonly forward: AnnotationPatchV1;
  readonly inverse: AnnotationPatchV1;
}

export interface HostRecordedDirectionAttemptV1 extends RecoveryAttemptCommonV1 {
  readonly kind: "host-recorded-undo" | "host-recorded-redo";
  readonly acknowledgement: HostAcknowledgementV1;
  readonly directionPatch: AnnotationPatchV1;
}

export type RecoveryAttemptV1 =
  | PreparedForwardAttemptV1
  | HostRecordedForwardAttemptV1
  | HostRecordedDirectionAttemptV1;

export interface SidecarRecoveryAcknowledgementV1 {
  readonly noteIdentity: NoteIdentityV1;
  readonly expectedPriorBase: SidecarBaseIdentityV1;
  readonly acknowledgedReplacementBase: SidecarBaseIdentityV1;
  readonly coveredAttemptIds: readonly RecoveryAttemptId[];
  readonly coveredCheckpointIds: readonly SourceCheckpointId[];
  readonly sidecarRevision: SidecarRevision;
  readonly sceneRevision: SceneRevision;
  readonly sourceGeneration: SourceGeneration;
  readonly sourceDigest: Sha256Digest;
}

export type FileRelocationStepV1 =
  | "prepared"
  | "sidecar-moved"
  | "identities-rekeyed"
  | "sidecar-metadata-saved"
  | "marker-saved"
  | "checkpoint-acknowledged"
  | "complete";

export interface FileRelocationRecordV1 {
  readonly kind: "markdown-file" | "sidecar-location";
  readonly relocationId: RelocationId;
  readonly noteIdentity: NoteIdentityV1;
  readonly sidecarBase: SidecarBaseIdentityV1;
  readonly expectedSceneRevision: SceneRevision;
  readonly expectedSettingsRevision: SettingsRevision;
  readonly sourceMarkdownPath: string;
  readonly destinationMarkdownPath: string;
  readonly sourceSidecarPath: string;
  readonly destinationSidecarPath: string;
  readonly step: FileRelocationStepV1;
}

export interface PrefixRelocationRecordV1 {
  readonly kind: "folder-prefix" | "storage-root";
  readonly relocationId: RelocationId;
  readonly priorPrefix: string;
  readonly replacementPrefix: string;
  readonly generation: number;
  readonly expectedSettingsRevision: SettingsRevision;
  readonly cursor: number;
  readonly admittedRecordCount: number;
  readonly step: "prepared" | "processing" | "complete";
}

export type RelocationRecordV1 =
  FileRelocationRecordV1 | PrefixRelocationRecordV1;

export interface RelocationTransitionV1 {
  readonly expected: RelocationRecordV1;
  readonly replacement: RelocationRecordV1;
}

export interface RemovalRecordV1 {
  readonly kind: "annotation-removal";
  readonly removalId: RemovalId;
  readonly noteIdentity: NoteIdentityV1;
  readonly sidecarBase: SidecarBaseIdentityV1;
  readonly expectedSceneRevision: SceneRevision;
  readonly deadlineEpochMs: number;
  readonly trashAcknowledged: boolean;
  readonly deleteEventAcknowledged: boolean;
  readonly markerState: "present" | "removing" | "removed";
}

export interface RemovalTransitionV1 {
  readonly expected: RemovalRecordV1;
  readonly replacement: RemovalRecordV1;
}

export interface RecoverySagaCompletionV1 {
  readonly kind: "relocation" | "removal";
  readonly id: RelocationId | RemovalId;
  readonly expectedTerminalRecordSha256: Sha256Digest;
}

export interface RecoveryRekeyV1 {
  readonly prior: NoteIdentityV1;
  readonly replacement: NoteIdentityV1;
  readonly relocationId: RelocationId;
}

interface ExistingSidecarRecoveryLoadRequestV1 {
  readonly kind: "existing-sidecar";
  readonly noteIdentity: NoteIdentityV1;
  readonly base: SidecarBaseIdentityV1;
  readonly validatedSidecarSourceGeneration: SourceGeneration;
  readonly validatedSidecarSourceDigest: Sha256Digest;
  readonly currentMarkdownDigest: Sha256Digest;
  readonly currentMarkdownUtf16Length: number;
}

interface AbsentFirstSidecarRecoveryLoadRequestV1 {
  readonly kind: "absent-first-sidecar";
  readonly noteIdentity: NoteIdentityV1;
  readonly base: SidecarBaseIdentityV1;
  readonly expectedVaultRelativePath: string;
  readonly currentMarkdownDigest: Sha256Digest;
  readonly currentMarkdownUtf16Length: number;
}

export type RecoveryLoadRequestV1 =
  | ExistingSidecarRecoveryLoadRequestV1
  | AbsentFirstSidecarRecoveryLoadRequestV1;

export interface RecoverySnapshotV1 {
  readonly attempts: readonly RecoveryAttemptV1[];
  readonly checkpoints: readonly SourceCheckpointOperationV1[];
  readonly relocations: readonly RelocationRecordV1[];
  readonly removals: readonly RemovalRecordV1[];
}

export interface DiscardConfirmedNoteRecoveryV1 {
  readonly noteIdentity: NoteIdentityV1;
  readonly expectedBase: SidecarBaseIdentityV1;
  readonly expectedAttempts: readonly RecoveryAttemptV1[];
  readonly expectedCheckpoints: readonly SourceCheckpointOperationV1[];
}

export interface FinalizeRemovalRecoveryV1 {
  readonly expectedRemoval: RemovalRecordV1;
  readonly expectedAttempts: readonly RecoveryAttemptV1[];
  readonly expectedCheckpoints: readonly SourceCheckpointOperationV1[];
}

export interface LoadActiveRemovalV1 {
  readonly noteIdentity: NoteIdentityV1;
}

export interface ActiveRemovalRecoveryV1 {
  readonly removal: RemovalRecordV1;
  readonly attempts: readonly RecoveryAttemptV1[];
  readonly checkpoints: readonly SourceCheckpointOperationV1[];
}

export interface PrefixRelocationPlanV1 {
  readonly relocationId: RelocationId;
  readonly generation: number;
  readonly admittedRecordCount: number;
  readonly expectedSettingsRevision: SettingsRevision;
}

export interface PrefixRelocationMemberV1 {
  readonly ordinal: number;
  readonly priorNoteIdentity: NoteIdentityV1;
  readonly replacementNoteIdentity: NoteIdentityV1;
  readonly expectedSceneRevision: SceneRevision | null;
  readonly sidecarBase: SidecarBaseIdentityV1 | null;
  readonly sourceSidecarPath: string | null;
  readonly destinationSidecarPath: string | null;
}

export interface PreparePrefixRelocationPlanV1 {
  readonly expectedPrefixRecord: PrefixRelocationRecordV1;
  readonly members: readonly PrefixRelocationMemberV1[];
}

export interface LoadPrefixRelocationMemberV1 {
  readonly relocationId: RelocationId;
  readonly ordinal: number;
}

export interface LoadRelocationByIdV1 {
  readonly relocationId: RelocationId;
}

export interface LoadActivePrefixRelocationsV1 {
  readonly limit: number;
}

export interface LoadRetainedPrefixRelocationRulesV1 {
  readonly limit: number;
}

export interface BeginPrefixRelocationBatchV1 {
  readonly records: readonly PrefixRelocationRecordV1[];
}

export interface RemoveRetainedPrefixRelocationRuleForMaintenanceV1 {
  readonly expectedRule: PrefixRelocationRecordV1;
}

export type RecoveryPersistenceRecordV1 =
  | RecoveryAttemptV1
  | SourceCheckpointOperationV1
  | RelocationRecordV1
  | RemovalRecordV1;
