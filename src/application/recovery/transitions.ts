import { commandFailure, commandSuccess } from "../note-session/results";
import type { CommandResultV1 } from "../note-session/types";
import {
  parseRelocationId,
  parseRemovalId,
} from "../note-session/value-objects";
import type {
  FileRelocationRecordV1,
  FileRelocationStepV1,
  PrefixRelocationRecordV1,
  RelocationRecordV1,
  RelocationTransitionV1,
  RemovalRecordV1,
  RemovalTransitionV1,
} from "./types";
import {
  isNormalizedVaultPath,
  isNormalizedVaultPrefix,
  isValidNoteIdentity,
  isValidSidecarBase,
  sameNoteIdentity,
  sameSidecarBase,
} from "./validation";

const FILE_STEPS: readonly FileRelocationStepV1[] = Object.freeze([
  "prepared",
  "sidecar-moved",
  "identities-rekeyed",
  "sidecar-metadata-saved",
  "marker-saved",
  "checkpoint-acknowledged",
  "complete",
]);
const MARKER_RANK = Object.freeze({ present: 0, removing: 1, removed: 2 });

export function validateRelocationStart(
  record: RelocationRecordV1,
): CommandResultV1<RelocationRecordV1> {
  if (record.step !== "prepared") return commandFailure("invalid-command");
  const validation = validateRelocationRecord(record);
  if (!validation.ok) return validation;
  if (!isFileRelocation(record) && record.cursor !== 0) {
    return commandFailure("invalid-command");
  }
  return commandSuccess(record);
}

export function validateRelocationRecord(
  record: RelocationRecordV1,
): CommandResultV1<RelocationRecordV1> {
  const valid = isFileRelocation(record)
    ? validFileFields(record)
    : validPrefixFields(record);
  return valid ? commandSuccess(record) : commandFailure("invalid-command");
}

export function validateRelocationTransition(
  transition: RelocationTransitionV1,
): CommandResultV1<RelocationRecordV1> {
  const { expected, replacement } = transition;
  if (
    expected.kind !== replacement.kind ||
    expected.relocationId !== replacement.relocationId
  ) {
    return commandFailure("invalid-command");
  }
  if (isFileRelocation(expected) && isFileRelocation(replacement)) {
    return validateFileTransition(expected, replacement);
  }
  if (!isFileRelocation(expected) && !isFileRelocation(replacement)) {
    return validatePrefixTransition(expected, replacement);
  }
  return commandFailure("invalid-command");
}

export function validateRemovalStart(
  record: RemovalRecordV1,
): CommandResultV1<RemovalRecordV1> {
  const valid =
    !record.trashAcknowledged &&
    !record.deleteEventAcknowledged &&
    record.markerState === "present" &&
    Number.isSafeInteger(record.deadlineEpochMs) &&
    record.deadlineEpochMs > 0 &&
    validateRemovalRecord(record).ok;
  return valid ? commandSuccess(record) : commandFailure("invalid-command");
}

export function validateRemovalRecord(
  record: RemovalRecordV1,
): CommandResultV1<RemovalRecordV1> {
  const valid =
    isRemovalKind(record.kind) &&
    isRemovalId(record.removalId) &&
    typeof record.trashAcknowledged === "boolean" &&
    typeof record.deleteEventAcknowledged === "boolean" &&
    isRemovalMarkerState(record.markerState) &&
    isNonNegativeRevision(record.expectedSceneRevision) &&
    Number.isSafeInteger(record.deadlineEpochMs) &&
    record.deadlineEpochMs > 0 &&
    isValidNoteIdentity(record.noteIdentity) &&
    validSidecarBase(record.sidecarBase);
  return valid ? commandSuccess(record) : commandFailure("invalid-command");
}

export function validateRemovalTransition(
  transition: RemovalTransitionV1,
): CommandResultV1<RemovalRecordV1> {
  const { expected, replacement } = transition;
  if (
    !validateRemovalRecord(expected).ok ||
    !validateRemovalRecord(replacement).ok ||
    !sameRemovalIdentity(expected, replacement)
  ) {
    return commandFailure("invalid-command");
  }
  const trashProgress =
    !expected.trashAcknowledged && replacement.trashAcknowledged;
  const eventProgress =
    !expected.deleteEventAcknowledged && replacement.deleteEventAcknowledged;
  const markerProgress =
    MARKER_RANK[replacement.markerState] ===
    MARKER_RANK[expected.markerState] + 1;
  const flagRegression =
    (expected.trashAcknowledged && !replacement.trashAcknowledged) ||
    (expected.deleteEventAcknowledged && !replacement.deleteEventAcknowledged);
  const markerRegressionOrSkip =
    MARKER_RANK[replacement.markerState] < MARKER_RANK[expected.markerState] ||
    MARKER_RANK[replacement.markerState] >
      MARKER_RANK[expected.markerState] + 1;
  if (
    flagRegression ||
    markerRegressionOrSkip ||
    (!trashProgress && !eventProgress && !markerProgress)
  ) {
    return commandFailure("invalid-command");
  }
  return commandSuccess(replacement);
}

export function isTerminalRelocation(record: RelocationRecordV1): boolean {
  return (
    record.step === "complete" &&
    (isFileRelocation(record) || record.cursor === record.admittedRecordCount)
  );
}

export function isTerminalRemoval(record: RemovalRecordV1): boolean {
  return (
    record.trashAcknowledged &&
    record.deleteEventAcknowledged &&
    record.markerState === "removed"
  );
}

function validateFileTransition(
  expected: FileRelocationRecordV1,
  replacement: FileRelocationRecordV1,
): CommandResultV1<RelocationRecordV1> {
  const currentIndex = FILE_STEPS.indexOf(expected.step);
  const valid =
    currentIndex >= 0 &&
    FILE_STEPS[currentIndex + 1] === replacement.step &&
    sameFileFields(expected, replacement) &&
    validFileFields(expected) &&
    validFileFields(replacement);
  return valid
    ? commandSuccess(replacement)
    : commandFailure("invalid-command");
}

function validatePrefixTransition(
  expected: PrefixRelocationRecordV1,
  replacement: PrefixRelocationRecordV1,
): CommandResultV1<RelocationRecordV1> {
  if (
    !samePrefixFields(expected, replacement) ||
    !validPrefixFields(expected) ||
    !validPrefixFields(replacement)
  ) {
    return commandFailure("invalid-command");
  }
  const zeroWorkCompletion =
    expected.step === "prepared" &&
    expected.admittedRecordCount === 0 &&
    replacement.step === "complete" &&
    replacement.cursor === 0;
  const startsProcessing =
    expected.step === "prepared" &&
    replacement.step === "processing" &&
    replacement.cursor > expected.cursor;
  const continuesProcessing =
    expected.step === "processing" &&
    replacement.step === "processing" &&
    replacement.cursor > expected.cursor;
  const completes =
    expected.step === "processing" &&
    replacement.step === "complete" &&
    replacement.cursor === expected.cursor &&
    replacement.cursor === replacement.admittedRecordCount;
  return zeroWorkCompletion ||
    startsProcessing ||
    continuesProcessing ||
    completes
    ? commandSuccess(replacement)
    : commandFailure("invalid-command");
}

function isFileRelocation(
  record: RelocationRecordV1,
): record is FileRelocationRecordV1 {
  return record.kind === "markdown-file" || record.kind === "sidecar-location";
}

function validFileFields(record: FileRelocationRecordV1): boolean {
  return (
    isFileRelocationKind(record.kind) &&
    isRelocationId(record.relocationId) &&
    FILE_STEPS.includes(record.step) &&
    isNonNegativeRevision(record.expectedSceneRevision) &&
    isPositiveCounter(record.expectedSettingsRevision) &&
    validSidecarBase(record.sidecarBase) &&
    isValidNoteIdentity(record.noteIdentity) &&
    isNormalizedVaultPath(record.sourceMarkdownPath) &&
    isNormalizedVaultPath(record.destinationMarkdownPath) &&
    isNormalizedVaultPath(record.sourceSidecarPath) &&
    isNormalizedVaultPath(record.destinationSidecarPath) &&
    record.sourceMarkdownPath !== record.destinationMarkdownPath &&
    record.sourceSidecarPath !== record.destinationSidecarPath
  );
}

function validPrefixFields(record: PrefixRelocationRecordV1): boolean {
  const validValues =
    isPrefixRelocationKind(record.kind) &&
    isRelocationId(record.relocationId) &&
    isPositiveCounter(record.generation) &&
    isPositiveCounter(record.expectedSettingsRevision) &&
    Number.isSafeInteger(record.cursor) &&
    record.cursor >= 0 &&
    Number.isSafeInteger(record.admittedRecordCount) &&
    record.admittedRecordCount >= 0 &&
    record.cursor <= record.admittedRecordCount &&
    isNormalizedVaultPrefix(record.priorPrefix) &&
    isNormalizedVaultPrefix(record.replacementPrefix) &&
    record.priorPrefix !== record.replacementPrefix;
  if (!validValues) return false;
  if (record.step === "prepared") return record.cursor === 0;
  if (record.step === "complete") {
    return record.cursor === record.admittedRecordCount;
  }
  return record.cursor > 0;
}

function validSidecarBase(
  base: FileRelocationRecordV1["sidecarBase"],
): boolean {
  return isValidSidecarBase(base);
}

function sameFileFields(
  left: FileRelocationRecordV1,
  right: FileRelocationRecordV1,
): boolean {
  return (
    left.kind === right.kind &&
    left.relocationId === right.relocationId &&
    sameNoteIdentity(left.noteIdentity, right.noteIdentity) &&
    sameSidecarBase(left.sidecarBase, right.sidecarBase) &&
    left.expectedSceneRevision === right.expectedSceneRevision &&
    left.expectedSettingsRevision === right.expectedSettingsRevision &&
    left.sourceMarkdownPath === right.sourceMarkdownPath &&
    left.destinationMarkdownPath === right.destinationMarkdownPath &&
    left.sourceSidecarPath === right.sourceSidecarPath &&
    left.destinationSidecarPath === right.destinationSidecarPath
  );
}

function samePrefixFields(
  left: PrefixRelocationRecordV1,
  right: PrefixRelocationRecordV1,
): boolean {
  return (
    left.kind === right.kind &&
    left.relocationId === right.relocationId &&
    left.priorPrefix === right.priorPrefix &&
    left.replacementPrefix === right.replacementPrefix &&
    left.generation === right.generation &&
    left.expectedSettingsRevision === right.expectedSettingsRevision &&
    left.admittedRecordCount === right.admittedRecordCount
  );
}

function sameRemovalIdentity(
  left: RemovalRecordV1,
  right: RemovalRecordV1,
): boolean {
  return (
    left.removalId === right.removalId &&
    sameNoteIdentity(left.noteIdentity, right.noteIdentity) &&
    sameSidecarBase(left.sidecarBase, right.sidecarBase) &&
    left.expectedSceneRevision === right.expectedSceneRevision &&
    left.deadlineEpochMs === right.deadlineEpochMs
  );
}

function isPositiveCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isRelocationId(value: string): boolean {
  try {
    parseRelocationId(value);
    return true;
  } catch {
    return false;
  }
}

function isRemovalId(value: string): boolean {
  try {
    parseRemovalId(value);
    return true;
  } catch {
    return false;
  }
}

function isFileRelocationKind(value: unknown): boolean {
  return value === "markdown-file" || value === "sidecar-location";
}

function isPrefixRelocationKind(value: unknown): boolean {
  return value === "folder-prefix" || value === "storage-root";
}

function isRemovalKind(value: unknown): boolean {
  return value === "annotation-removal";
}

function isRemovalMarkerState(value: unknown): boolean {
  return value === "present" || value === "removing" || value === "removed";
}
