import { createSceneRevision } from "../../domain/model";
import { createSidecarRevision } from "../note-session";
import type {
  FirstSidecarPendingV1,
  NoteSessionSnapshotV1,
  Sha256Digest,
} from "../note-session";
import { sameNoteIdentity } from "../recovery";
import type {
  FirstSidecarRecoveryContextV1,
  SidecarBaseIdentityV1,
  SidecarRecoveryAcknowledgementV1,
} from "../recovery";
import type {
  FirstSidecarCapturedRevisionV1,
  FirstSidecarCommandV1,
  FirstSidecarPreparedDispatchV1,
  FirstSidecarSourceEvidenceV1,
} from "./first-sidecar-types";
import type { InkbookSidecarV1 } from "./types";

const FIRST_REVISION = 1;

export function createFirstSidecarPending<TDispatch>(
  command: FirstSidecarCommandV1,
  evidence: FirstSidecarSourceEvidenceV1,
  prepared: FirstSidecarPreparedDispatchV1<TDispatch>,
): FirstSidecarPendingV1 {
  return Object.freeze({
    expectedSettingsRevision: command.expectedSettingsRevision,
    expectedSourceDigest: evidence.digest,
    expectedSourceGeneration: evidence.generation,
    expectedVaultRelativePath: command.expectedVaultRelativePath,
    historyEntryId: command.historyEntryId,
    noteIdentity: command.noteIdentity,
    operationId: command.operationId,
    recoveryAttemptId: prepared.recoveryAttemptId,
  });
}

export function createFirstSidecarRevision(
  command: FirstSidecarCommandV1,
  capture: FirstSidecarCapturedRevisionV1,
  savedAtEpochMs: number,
): InkbookSidecarV1 {
  return Object.freeze({
    baseRevision: null,
    format: "inkbook-obsidian-annotations",
    noteIdentity: Object.freeze({
      markdownContentDigest: capture.evidence.digest,
      sourceGeneration: capture.evidence.generation,
      vaultRelativeMarkdownPath: command.noteIdentity.vaultRelativeMarkdownPath,
    }),
    revision: FIRST_REVISION,
    savedAtEpochMs,
    scene: capture.scene,
    schemaVersion: Object.freeze({ major: 1, minor: 0 }),
    storageLayout: command.storageLayout,
  });
}

export function createFirstSidecarAcknowledgement(
  command: FirstSidecarCommandV1,
  capture: FirstSidecarCapturedRevisionV1,
  rawTextSha256: Sha256Digest,
): SidecarRecoveryAcknowledgementV1 {
  const prior = absentBase(command);
  return Object.freeze({
    acknowledgedReplacementBase: Object.freeze({
      ...prior,
      rawTextSha256,
      revision: createSidecarRevision(FIRST_REVISION),
    }),
    coveredAttemptIds: Object.freeze([capture.pending.recoveryAttemptId]),
    coveredCheckpointIds: Object.freeze([capture.evidence.checkpointId]),
    expectedPriorBase: prior,
    noteIdentity: command.noteIdentity,
    sceneRevision: capture.scene.revision,
    sidecarRevision: createSidecarRevision(FIRST_REVISION),
    sourceDigest: capture.evidence.digest,
    sourceGeneration: capture.evidence.generation,
  });
}

export function createFirstSidecarRecoveryContext(
  command: FirstSidecarCommandV1,
  evidence: FirstSidecarSourceEvidenceV1,
): FirstSidecarRecoveryContextV1 {
  return Object.freeze({
    expectedSceneRevision: createSceneRevision(0),
    expectedSettingsRevision: command.expectedSettingsRevision,
    expectedSourceDigest: evidence.digest,
    expectedSourceGeneration: evidence.generation,
    expectedVaultRelativePath: command.expectedVaultRelativePath,
    historyEntryId: command.historyEntryId,
    noteIdentity: command.noteIdentity,
    operationId: command.operationId,
  });
}

export function firstSidecarPendingMatchesSnapshot(
  pending: FirstSidecarPendingV1,
  snapshot: NoteSessionSnapshotV1,
): boolean {
  return (
    snapshot.persistence.kind === "first-sidecar-pending" &&
    samePending(pending, snapshot.persistence.pending)
  );
}

export function freezeFirstSidecarEvidence(
  evidence: FirstSidecarSourceEvidenceV1,
): FirstSidecarSourceEvidenceV1 {
  return Object.freeze({ ...evidence });
}

export function freezeFirstSidecarCommand(
  command: FirstSidecarCommandV1,
): FirstSidecarCommandV1 {
  return Object.freeze({
    ...command,
    noteIdentity: Object.freeze({ ...command.noteIdentity }),
    storageLayout: Object.freeze({ ...command.storageLayout }),
  });
}

function absentBase(command: FirstSidecarCommandV1): SidecarBaseIdentityV1 {
  return Object.freeze({
    markdownPath: command.noteIdentity.vaultRelativeMarkdownPath,
    rawTextSha256: null,
    revision: null,
    vaultRelativePath: command.expectedVaultRelativePath,
  });
}

function samePending(
  left: FirstSidecarPendingV1,
  right: FirstSidecarPendingV1,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.historyEntryId === right.historyEntryId &&
    left.recoveryAttemptId === right.recoveryAttemptId &&
    left.expectedSettingsRevision === right.expectedSettingsRevision &&
    left.expectedSourceGeneration === right.expectedSourceGeneration &&
    left.expectedSourceDigest === right.expectedSourceDigest &&
    left.expectedVaultRelativePath === right.expectedVaultRelativePath &&
    sameNoteIdentity(left.noteIdentity, right.noteIdentity)
  );
}
