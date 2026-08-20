import {
  createAnnotationOperationV1,
  isHistoryEntryId,
  isHistoryEpoch,
  validateAnnotationHistoryEntryV1,
} from "../../domain/operations";
import { encodeCanonicalJson } from "../../domain/codecs";
import { parseHostEffectId } from "../note-session";
import { isValidNoteIdentity as isValidRecoveryNoteIdentity } from "../recovery/validation";
import type {
  AcceptedDeliverySnapshotV1,
  ActionableHistoryEntrySnapshotV1,
  EditorEpochHighWaterSnapshotV1,
  HostDispatchIntentV1,
  HostEffectEnvelopeV1,
  HostHistoryLimitsV1,
  HostHistorySnapshotV1,
  NoteIdentityV1,
} from "./types";

export const DEFAULT_HOST_HISTORY_LIMITS: HostHistoryLimitsV1 = Object.freeze({
  maxActionableEntries: 256,
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  maxPayloadBytes: 32 * 1024 * 1024,
});

const MAX_ID_LENGTH = 128;
const MAX_IDENTITY_PART_LENGTH = 1024;
const ENVELOPE_KEYS = [
  "direction",
  "effectId",
  "historyEntryId",
  "historyEpoch",
  "noteIdentity",
] as const;
const NOTE_IDENTITY_KEYS = [
  "vaultIdHint",
  "vaultRelativeMarkdownPath",
] as const;

export function sameNoteIdentity(
  left: NoteIdentityV1,
  right: NoteIdentityV1,
): boolean {
  return (
    left.vaultIdHint === right.vaultIdHint &&
    left.vaultRelativeMarkdownPath === right.vaultRelativeMarkdownPath
  );
}

export function isValidEnvelope(value: unknown): value is HostEffectEnvelopeV1 {
  try {
    const fields = plainDataValues(value, ENVELOPE_KEYS);
    if (fields === null) return false;
    const [direction, effectId, historyEntryId, historyEpoch, noteIdentity] =
      fields;
    return (
      (direction === "forward" || direction === "inverse") &&
      isValidHostEffectId(effectId) &&
      isHistoryEntryId(historyEntryId) &&
      isHistoryEpoch(historyEpoch) &&
      isValidNoteIdentityValue(noteIdentity)
    );
  } catch {
    return false;
  }
}

export function isValidHistoryEntry(value: unknown): boolean {
  try {
    return validateAnnotationHistoryEntryV1(value).ok;
  } catch {
    return false;
  }
}

export function isPositiveCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function estimateEntryBytes(entry: ActionableHistoryEntrySnapshotV1): number {
  return encodeCanonicalJson(entry).byteLength;
}

export function fitsLimits(
  entries: readonly ActionableHistoryEntrySnapshotV1[],
  limits: HostHistoryLimitsV1,
): boolean {
  if (entries.length > limits.maxActionableEntries) return false;
  try {
    return (
      entries.reduce((total, entry) => total + estimateEntryBytes(entry), 0) <=
      limits.maxPayloadBytes
    );
  } catch {
    return false;
  }
}

export function isValidSnapshot(
  snapshot: HostHistorySnapshotV1,
  noteIdentity: NoteIdentityV1,
  limits: HostHistoryLimitsV1,
): boolean {
  if (
    !sameNoteIdentity(snapshot.noteIdentity, noteIdentity) ||
    !isValidSceneRevision(snapshot.scene.revision) ||
    !isPositiveCounter(snapshot.nextEpoch) ||
    snapshot.lease.kind === "blocked" ||
    (snapshot.lease.kind === "owned" &&
      snapshot.nextEpoch <= snapshot.lease.epoch) ||
    !fitsLimits(snapshot.entries, limits) ||
    !hasUnique(snapshot.entries, (entry) => entry.effectId) ||
    !hasUnique(
      snapshot.entries,
      (entry) => entry.historyEntry.historyEntryId,
    ) ||
    !hasUnique(snapshot.highWaterMarks, editorEpochSnapshotKey) ||
    !hasUnique(snapshot.acceptedDeliveries, editorEpochSnapshotKey)
  ) {
    return false;
  }
  return (
    snapshot.entries.every((entry) => isValidEntry(entry, snapshot)) &&
    snapshot.highWaterMarks.every((mark) => isValidHighWater(mark, snapshot)) &&
    snapshot.acceptedDeliveries.every((delivery) =>
      isValidAcceptedDelivery(delivery, snapshot),
    )
  );
}

function isValidSceneRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidEntry(
  entry: ActionableHistoryEntrySnapshotV1,
  snapshot: HostHistorySnapshotV1,
): boolean {
  if (
    !isValidHistoryEntry(entry.historyEntry) ||
    !isValidNoteIdentityValue(entry.noteIdentity)
  ) {
    return false;
  }
  if (
    snapshot.lease.kind !== "owned" ||
    snapshot.lease.ownerViewId !== entry.ownerViewId ||
    snapshot.lease.epoch !== entry.historyEntry.historyEpoch ||
    !isBoundedString(entry.recoveryAttemptId, MAX_ID_LENGTH)
  ) {
    return false;
  }
  return isValidIntent(entry.preparedForward, entry.historyEntry);
}

function isValidIntent(
  intent: HostDispatchIntentV1,
  historyEntry: ActionableHistoryEntrySnapshotV1["historyEntry"],
): boolean {
  if (
    !createAnnotationOperationV1(intent).ok ||
    intent.direction !== "forward" ||
    intent.historyEntryId !== historyEntry.historyEntryId ||
    intent.historyEpoch !== historyEntry.historyEpoch
  ) {
    return false;
  }
  return validateAnnotationHistoryEntryV1({
    forward: intent.patch,
    historyEntryId: historyEntry.historyEntryId,
    historyEpoch: historyEntry.historyEpoch,
    inverse: historyEntry.inverse,
  }).ok;
}

function isValidAcceptedDelivery(
  delivery: AcceptedDeliverySnapshotV1,
  snapshot: HostHistorySnapshotV1,
): boolean {
  const { envelope, intent } = delivery;
  const mark = snapshot.highWaterMarks.find(
    (candidate) =>
      editorEpochSnapshotKey(candidate) === editorEpochSnapshotKey(delivery),
  );
  const entry = snapshot.entries.find(
    (candidate) => candidate.effectId === envelope.effectId,
  );
  return (
    isValidEnvelope(envelope) &&
    entry !== undefined &&
    sameNoteIdentity(envelope.noteIdentity, entry.noteIdentity) &&
    isBoundedString(delivery.editorViewId, MAX_ID_LENGTH) &&
    isPositiveCounter(delivery.sequence) &&
    delivery.sequence === mark?.sequence &&
    intent.historyEntryId === envelope.historyEntryId &&
    intent.historyEpoch === envelope.historyEpoch &&
    createAnnotationOperationV1(intent).ok &&
    ((envelope.direction === "inverse" && intent.direction === "inverse") ||
      (envelope.direction === "forward" && intent.direction === "forward"))
  );
}

function isValidHighWater(
  mark: EditorEpochHighWaterSnapshotV1,
  snapshot: HostHistorySnapshotV1,
): boolean {
  return (
    isBoundedString(mark.editorViewId, MAX_ID_LENGTH) &&
    isPositiveCounter(mark.historyEpoch) &&
    isPositiveCounter(mark.sequence) &&
    snapshot.lease.kind === "owned" &&
    snapshot.lease.epoch === mark.historyEpoch
  );
}

function editorEpochSnapshotKey(value: {
  readonly editorViewId: string;
  readonly historyEpoch: number;
}): string {
  return `${value.editorViewId}\u0000${String(value.historyEpoch)}`;
}

function hasUnique<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): boolean {
  const keys = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function isBoundedString(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum;
}

function isBoundedStringValue(
  value: unknown,
  maximum: number,
): value is string {
  return typeof value === "string" && isBoundedString(value, maximum);
}

function isValidNoteIdentityValue(value: unknown): value is NoteIdentityV1 {
  if (!isValidRecoveryNoteIdentity(value)) return false;
  const fields = plainDataValues(value, NOTE_IDENTITY_KEYS);
  if (fields === null) return false;
  const [vaultIdHint, vaultRelativeMarkdownPath] = fields;
  return (
    isBoundedStringValue(vaultIdHint, MAX_IDENTITY_PART_LENGTH) &&
    isBoundedStringValue(vaultRelativeMarkdownPath, MAX_IDENTITY_PART_LENGTH)
  );
}

function isValidHostEffectId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    parseHostEffectId(value);
    return true;
  } catch {
    return false;
  }
}

function plainDataValues(
  value: unknown,
  keys: readonly string[],
): readonly unknown[] | null {
  if (typeof value !== "object" || value === null) return null;
  const objectValue = value;
  const prototype = Reflect.getPrototypeOf(objectValue);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const ownKeys = Reflect.ownKeys(objectValue);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return null;
  }
  const values: unknown[] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    values.push(descriptor.value);
  }
  return values;
}
