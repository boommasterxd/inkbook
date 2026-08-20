import type { CommandResultV1, RecoveryAttemptId } from "../note-session/types";
import type { SourceCheckpointOperationV1 } from "../source-coordination/types";
import type {
  HostAcknowledgementV1,
  HostRecordedDirectionAttemptV1,
  PreparedForwardAttemptV1,
  RecoveryLoadRequestV1,
  RecoveryRekeyV1,
  RecoverySagaCompletionV1,
  RecoverySnapshotV1,
  RelocationRecordV1,
  RelocationTransitionV1,
  RemovalRecordV1,
  RemovalTransitionV1,
  SidecarRecoveryAcknowledgementV1,
} from "./types";

const RECOVERY_KIBIBYTE = 1024;
const RECOVERY_MEBIBYTE = RECOVERY_KIBIBYTE * RECOVERY_KIBIBYTE;

export const RECOVERY_STORE_LIMITS_V1 = Object.freeze({
  maxDirectSuccessorsPerBase: 512,
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  maxGlobalBytes: 32 * RECOVERY_MEBIBYTE,
  maxGlobalRecords: 16_384,
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  maxNoteBytes: 8 * RECOVERY_MEBIBYTE,
  maxNoteRecords: 4096,
});

export interface RecoveryStore {
  prepareForward(
    attempt: PreparedForwardAttemptV1,
  ): Promise<CommandResultV1<void>>;
  recordForward(
    attemptId: RecoveryAttemptId,
    acknowledgement: HostAcknowledgementV1,
  ): Promise<CommandResultV1<void>>;
  appendDirection(
    attempt: HostRecordedDirectionAttemptV1,
  ): Promise<CommandResultV1<void>>;
  appendSourceCheckpoint(
    checkpoint: SourceCheckpointOperationV1,
  ): Promise<CommandResultV1<void>>;
  acknowledgeSidecar(
    request: SidecarRecoveryAcknowledgementV1,
  ): Promise<CommandResultV1<void>>;
  beginRelocation(record: RelocationRecordV1): Promise<CommandResultV1<void>>;
  advanceRelocation(
    request: RelocationTransitionV1,
  ): Promise<CommandResultV1<void>>;
  beginRemoval(record: RemovalRecordV1): Promise<CommandResultV1<void>>;
  advanceRemoval(request: RemovalTransitionV1): Promise<CommandResultV1<void>>;
  completeSaga(
    request: RecoverySagaCompletionV1,
  ): Promise<CommandResultV1<void>>;
  rekeyNote(request: RecoveryRekeyV1): Promise<CommandResultV1<void>>;
  loadNote(
    request: RecoveryLoadRequestV1,
  ): Promise<CommandResultV1<RecoverySnapshotV1>>;
  dispose(): Promise<void>;
}
