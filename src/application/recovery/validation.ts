import type { SceneRevision } from "../../domain/model";
import type { OperationId, HistoryEntryId } from "../../domain/operations";
import { commandFailure, commandSuccess } from "../note-session/results";
import type {
  CommandResultV1,
  FirstSidecarPendingV1,
  NoteIdentityV1,
  SettingsRevision,
  SourceGeneration,
  Sha256Digest,
} from "../note-session/types";
import {
  parseRecoveryAttemptId,
  parseSha256Digest,
  parseSourceCheckpointId,
} from "../note-session/value-objects";
import type {
  HostRecordedForwardAttemptV1,
  SidecarRecoveryAcknowledgementV1,
} from "./types";
import type { SidecarBaseIdentityV1 } from "./base";
import {
  isValidVaultRelativePathV1,
  isValidVaultRelativePrefixV1,
} from "../vault-path";

export interface FirstSidecarRecoveryContextV1 {
  readonly noteIdentity: NoteIdentityV1;
  readonly expectedVaultRelativePath: string;
  readonly expectedSettingsRevision: SettingsRevision;
  readonly expectedSourceGeneration: SourceGeneration;
  readonly expectedSourceDigest: Sha256Digest;
  readonly expectedSceneRevision: SceneRevision;
  readonly operationId: OperationId;
  readonly historyEntryId: HistoryEntryId;
}

export function sameNoteIdentity(
  left: NoteIdentityV1,
  right: NoteIdentityV1,
): boolean {
  return (
    left.vaultIdHint === right.vaultIdHint &&
    left.vaultRelativeMarkdownPath === right.vaultRelativeMarkdownPath
  );
}

export function sameSidecarBase(
  left: SidecarBaseIdentityV1,
  right: SidecarBaseIdentityV1,
): boolean {
  return (
    left.vaultRelativePath === right.vaultRelativePath &&
    left.revision === right.revision &&
    left.rawTextSha256 === right.rawTextSha256 &&
    left.markdownPath === right.markdownPath
  );
}

export function isNormalizedVaultPath(value: unknown): value is string {
  return isValidVaultRelativePathV1(value);
}

export function isNormalizedVaultPrefix(value: unknown): value is string {
  return isValidVaultRelativePrefixV1(value);
}

export function isValidNoteIdentity(value: unknown): value is NoteIdentityV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["vaultIdHint", "vaultRelativeMarkdownPath"]) &&
    typeof value.vaultIdHint === "string" &&
    value.vaultIdHint.length > 0 &&
    !value.vaultIdHint.includes("\0") &&
    isNormalizedVaultPath(value.vaultRelativeMarkdownPath)
  );
}

export function validateFirstSidecarRecovery(
  pending: FirstSidecarPendingV1,
  attempt: HostRecordedForwardAttemptV1,
  context: FirstSidecarRecoveryContextV1,
): CommandResultV1<void> {
  const valid =
    attempt.acknowledgement.direction === "forward" &&
    attempt.base.revision === null &&
    attempt.base.rawTextSha256 === null &&
    attempt.expectedSceneRevision === 0 &&
    pendingMatchesAttempt(pending, attempt) &&
    pendingMatchesContext(pending, context) &&
    attemptMatchesContext(attempt, context) &&
    attempt.base.vaultRelativePath === context.expectedVaultRelativePath &&
    attempt.base.markdownPath ===
      context.noteIdentity.vaultRelativeMarkdownPath;
  return valid ? commandSuccess(undefined) : commandFailure("invalid-command");
}

function pendingMatchesAttempt(
  pending: FirstSidecarPendingV1,
  attempt: HostRecordedForwardAttemptV1,
): boolean {
  return (
    pending.operationId === attempt.operationId &&
    pending.historyEntryId === attempt.historyEntryId &&
    pending.recoveryAttemptId === attempt.attemptId
  );
}

function pendingMatchesContext(
  pending: FirstSidecarPendingV1,
  context: FirstSidecarRecoveryContextV1,
): boolean {
  return (
    pending.expectedSettingsRevision === context.expectedSettingsRevision &&
    pending.expectedVaultRelativePath === context.expectedVaultRelativePath &&
    pending.expectedSourceGeneration === context.expectedSourceGeneration &&
    pending.expectedSourceDigest === context.expectedSourceDigest &&
    sameNoteIdentity(pending.noteIdentity, context.noteIdentity)
  );
}

function attemptMatchesContext(
  attempt: HostRecordedForwardAttemptV1,
  context: FirstSidecarRecoveryContextV1,
): boolean {
  return (
    attempt.operationId === context.operationId &&
    attempt.historyEntryId === context.historyEntryId &&
    attempt.expectedSourceGeneration === context.expectedSourceGeneration &&
    attempt.expectedSourceDigest === context.expectedSourceDigest &&
    attempt.expectedSceneRevision === context.expectedSceneRevision
  );
}

export function validateSidecarAcknowledgement(
  request: SidecarRecoveryAcknowledgementV1,
): CommandResultV1<void> {
  const replacement = request.acknowledgedReplacementBase;
  const prior = request.expectedPriorBase;
  const expectedRevision = prior.revision === null ? 1 : prior.revision + 1;
  if (
    !validAcknowledgementMetadata(request) ||
    replacement.revision !== request.sidecarRevision ||
    replacement.revision !== expectedRevision ||
    replacement.rawTextSha256 === null ||
    replacement.vaultRelativePath !== prior.vaultRelativePath ||
    replacement.markdownPath !== prior.markdownPath ||
    replacement.markdownPath !==
      request.noteIdentity.vaultRelativeMarkdownPath ||
    !isNormalizedVaultPath(replacement.vaultRelativePath) ||
    !isNormalizedVaultPath(replacement.markdownPath) ||
    !validCoverage(request)
  ) {
    return commandFailure("sidecar-conflict");
  }
  return commandSuccess(undefined);
}

function validAcknowledgementMetadata(
  request: SidecarRecoveryAcknowledgementV1,
): boolean {
  return (
    isValidNoteIdentity(request.noteIdentity) &&
    isValidSidecarBase(request.expectedPriorBase) &&
    isValidSidecarBase(request.acknowledgedReplacementBase) &&
    Number.isSafeInteger(request.sceneRevision) &&
    request.sceneRevision >= 0 &&
    Number.isSafeInteger(request.sourceGeneration) &&
    request.sourceGeneration > 0 &&
    isDigest(request.sourceDigest)
  );
}

function validCoverage(request: SidecarRecoveryAcknowledgementV1): boolean {
  return (
    !hasDuplicates(request.coveredAttemptIds) &&
    !hasDuplicates(request.coveredCheckpointIds) &&
    request.coveredAttemptIds.every(isAttemptId) &&
    request.coveredCheckpointIds.every(isCheckpointId)
  );
}

export function isValidSidecarBase(
  value: unknown,
): value is SidecarBaseIdentityV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "markdownPath",
      "rawTextSha256",
      "revision",
      "vaultRelativePath",
    ])
  ) {
    return false;
  }
  const hasNullVersion =
    value.revision === null && value.rawTextSha256 === null;
  const hasDurableVersion =
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0 &&
    typeof value.rawTextSha256 === "string" &&
    isDigest(value.rawTextSha256);
  return (
    (hasNullVersion || hasDurableVersion) &&
    isNormalizedVaultPath(value.vaultRelativePath) &&
    isNormalizedVaultPath(value.markdownPath)
  );
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function isAttemptId(value: string): boolean {
  try {
    parseRecoveryAttemptId(value);
    return true;
  } catch {
    return false;
  }
}

function isCheckpointId(value: string): boolean {
  try {
    parseSourceCheckpointId(value);
    return true;
  } catch {
    return false;
  }
}

function isDigest(value: string): boolean {
  try {
    parseSha256Digest(value);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
