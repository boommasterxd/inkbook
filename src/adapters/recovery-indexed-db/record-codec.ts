import type {
  HostAcknowledgementProbe,
  RecoveryNoteKey,
  RecoveryProbeRecord,
} from "./types";

const MAX_IDENTIFIER_LENGTH = 512;
const PREPARED_RECORD_KEYS = [
  "attemptId",
  "forwardPatch",
  "inversePatch",
  "kind",
  "note",
  "schemaVersion",
  "sessionOrder",
] as const;
const HOST_RECORDED_RECORD_KEYS = [
  "acknowledgement",
  ...PREPARED_RECORD_KEYS,
] as const;
const NOTE_KEYS = ["markdownPath", "vaultIdentityHint"] as const;
const ACKNOWLEDGEMENT_KEYS = [
  "direction",
  "editorViewId",
  "effectId",
  "transactionSequence",
] as const;

export function encodeRecord(record: RecoveryProbeRecord): string | null {
  if (!isRecoveryRecord(record)) {
    return null;
  }
  return JSON.stringify(record);
}

export function decodeRecord(serialized: string): RecoveryProbeRecord | null {
  try {
    const value: unknown = JSON.parse(serialized);
    return isRecoveryRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function recoveryNoteKey(note: RecoveryNoteKey): string | null {
  if (!isNote(note)) {
    return null;
  }
  return JSON.stringify([note.vaultIdentityHint, note.markdownPath]);
}

export function recoveryAttemptKey(
  noteKey: string,
  attemptId: string,
): string | null {
  if (!isIdentifier(attemptId)) {
    return null;
  }
  return JSON.stringify([noteKey, attemptId]);
}

export function recordsEqual(
  left: RecoveryProbeRecord,
  right: RecoveryProbeRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecoveryRecord(value: unknown): value is RecoveryProbeRecord {
  if (!isObject(value) || value.schemaVersion !== 1 || !isCommonRecord(value)) {
    return false;
  }
  if (value.kind === "prepared-forward") {
    return hasExactKeys(value, PREPARED_RECORD_KEYS);
  }
  const kind = value.kind;
  if (!isHostRecordedKind(kind)) {
    return false;
  }
  return (
    hasExactKeys(value, HOST_RECORDED_RECORD_KEYS) &&
    isAcknowledgement(value.acknowledgement) &&
    directionMatchesKind(kind, value.acknowledgement.direction)
  );
}

function isCommonRecord(value: Record<string, unknown>): boolean {
  return (
    isNote(value.note) &&
    isIdentifier(value.attemptId) &&
    isPositiveSafeInteger(value.sessionOrder) &&
    typeof value.forwardPatch === "string" &&
    typeof value.inversePatch === "string"
  );
}

function isAcknowledgement(value: unknown): value is HostAcknowledgementProbe {
  return (
    isObject(value) &&
    hasExactKeys(value, ACKNOWLEDGEMENT_KEYS) &&
    isIdentifier(value.editorViewId) &&
    isIdentifier(value.effectId) &&
    (value.direction === "forward" || value.direction === "inverse") &&
    isPositiveSafeInteger(value.transactionSequence)
  );
}

function directionMatchesKind(
  kind: "host-recorded-forward" | "host-recorded-undo" | "host-recorded-redo",
  direction: "forward" | "inverse",
): boolean {
  return kind === "host-recorded-undo"
    ? direction === "inverse"
    : direction === "forward";
}

function isHostRecordedKind(
  value: unknown,
): value is
  "host-recorded-forward" | "host-recorded-undo" | "host-recorded-redo" {
  return (
    value === "host-recorded-forward" ||
    value === "host-recorded-undo" ||
    value === "host-recorded-redo"
  );
}

function isNote(value: unknown): value is RecoveryNoteKey {
  return (
    isObject(value) &&
    hasExactKeys(value, NOTE_KEYS) &&
    isIdentifier(value.vaultIdentityHint) &&
    isIdentifier(value.markdownPath)
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !value.includes("\0")
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value).sort((left, right) =>
    left.localeCompare(right),
  );
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}
