import type { SerializedSceneStateV1 } from "../../domain/scene";
import type { OperationId, HistoryEntryId } from "../../domain/operations";
import type {
  FirstSidecarPendingV1,
  CommandResultV1,
  NoteIdentityV1,
  NoteSessionSnapshotV1,
  RecoveryAttemptId,
  SettingsRevision,
  Sha256Digest,
  SourceCheckpointId,
  SourceGeneration,
} from "../note-session";
import type {
  HostRecordedForwardAttemptV1,
  SidecarRecoveryAcknowledgementV1,
} from "../recovery";
import type { NoteSessionTurnV1 } from "../note-session/session";
import type { NoteSessionTurnResultV1 } from "../note-session/queue";
import type { InkbookSidecarV1, SidecarStorageLayoutV1 } from "./types";

export const FIRST_SIDECAR_TIMEOUT_MS_V1 = 2_000;

export interface FirstSidecarCommandV1 {
  readonly noteIdentity: NoteIdentityV1;
  readonly operationId: OperationId;
  readonly historyEntryId: HistoryEntryId;
  readonly expectedVaultRelativePath: string;
  readonly expectedSettingsRevision: SettingsRevision;
  readonly storageLayout: SidecarStorageLayoutV1;
}

export interface FirstSidecarSourceEvidenceV1 {
  readonly checkpointId: SourceCheckpointId;
  readonly generation: SourceGeneration;
  readonly digest: Sha256Digest;
}

export interface FirstSidecarPreparedDispatchV1<TDispatch> {
  readonly kind: "prepared";
  readonly recoveryAttemptId: RecoveryAttemptId;
  readonly dispatch: TDispatch;
}

export type FirstSidecarDispatchPreparationV1<TDispatch> =
  FirstSidecarPreparedDispatchV1<TDispatch> | { readonly kind: "rejected" };

interface FirstSidecarSessionPortV1 {
  readonly snapshot: NoteSessionSnapshotV1;
  enqueue(turn: NoteSessionTurnV1): Promise<NoteSessionTurnResultV1>;
}

export interface FirstSidecarTimerPortV1 {
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface FirstSidecarCreateRequestV1 {
  readonly expectedVaultRelativePath: string;
  readonly sidecar: InkbookSidecarV1;
  readonly signal: AbortSignal;
}

export type FirstSidecarCreateResultV1 =
  | { readonly kind: "created"; readonly rawTextSha256: Sha256Digest }
  | { readonly kind: "collision" }
  | { readonly kind: "failed" };

export interface FirstSidecarPortsV1<TDispatch> {
  readonly session: FirstSidecarSessionPortV1;
  readonly timer: FirstSidecarTimerPortV1;
  readonly admitNewSidecar: () => CommandResultV1<void>;
  readonly writeMarker: (
    command: FirstSidecarCommandV1,
    signal: AbortSignal,
  ) => Promise<{ readonly kind: "acknowledged" } | { readonly kind: "failed" }>;
  readonly awaitOwnedSourceCheckpoint: (
    command: FirstSidecarCommandV1,
    signal: AbortSignal,
  ) => Promise<FirstSidecarSourceEvidenceV1 | null>;
  readonly revalidate: (
    command: FirstSidecarCommandV1,
    evidence: FirstSidecarSourceEvidenceV1,
    snapshot: NoteSessionSnapshotV1,
  ) => boolean;
  readonly prepareDispatch: (
    command: FirstSidecarCommandV1,
    evidence: FirstSidecarSourceEvidenceV1,
    signal: AbortSignal,
  ) => Promise<FirstSidecarDispatchPreparationV1<TDispatch>>;
  readonly createIfAbsent: (
    request: FirstSidecarCreateRequestV1,
  ) => Promise<FirstSidecarCreateResultV1>;
  readonly acknowledgeRecovery: (
    acknowledgement: SidecarRecoveryAcknowledgementV1,
  ) => Promise<{ readonly ok: boolean }>;
  readonly nowEpochMs: () => number;
}

export type FirstSidecarPrepareResultV1<TDispatch> =
  | {
      readonly kind: "prepared";
      readonly dispatch: TDispatch;
      readonly pending: FirstSidecarPendingV1;
    }
  | { readonly kind: "drift" }
  | { readonly kind: "rejected" };

export interface FirstSidecarHostForwardV1 {
  readonly attempt: HostRecordedForwardAttemptV1;
}

export type FirstSidecarCompletionResultV1 =
  | { readonly kind: "acknowledged" }
  | { readonly kind: "conflict" }
  | { readonly kind: "drift" }
  | { readonly kind: "rejected" };

export interface FirstSidecarCapturedRevisionV1 {
  readonly scene: SerializedSceneStateV1;
  readonly pending: FirstSidecarPendingV1;
  readonly evidence: FirstSidecarSourceEvidenceV1;
}
