import type {
  ActionableHistoryEntrySnapshotV1,
  HistoryEpoch,
  HostDispatchIntentV1,
  HostEffectAcknowledgementV1,
  HostEffectDeliveryV1,
  HostEffectEnvelopeV1,
  HostHistoryCoordinatorConfigV1,
  HostHistoryLimitsV1,
  NoteIdentityV1,
  ViewId,
} from "./types";
import { DEFAULT_HOST_HISTORY_LIMITS, sameNoteIdentity } from "./validation";
import { isValidNoteIdentity } from "../recovery/validation";

export function resolveLimits(
  limits: HostHistoryCoordinatorConfigV1["limits"],
): HostHistoryLimitsV1 {
  const maxActionableEntries = validateLimit(
    limits?.maxActionableEntries ??
      DEFAULT_HOST_HISTORY_LIMITS.maxActionableEntries,
    DEFAULT_HOST_HISTORY_LIMITS.maxActionableEntries,
    "maxActionableEntries",
  );
  const maxPayloadBytes = validateLimit(
    limits?.maxPayloadBytes ?? DEFAULT_HOST_HISTORY_LIMITS.maxPayloadBytes,
    DEFAULT_HOST_HISTORY_LIMITS.maxPayloadBytes,
    "maxPayloadBytes",
  );
  return Object.freeze({
    maxActionableEntries,
    maxPayloadBytes,
  });
}

function validateLimit(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(
      `${name} must be a positive safe integer within its limit.`,
    );
  }
  return value;
}

export function freezeNoteIdentity(
  noteIdentity: NoteIdentityV1,
): NoteIdentityV1 {
  return Object.freeze({ ...noteIdentity });
}

export function resolveRekeyedNoteIdentity(
  current: NoteIdentityV1,
  prior: NoteIdentityV1,
  replacement: NoteIdentityV1,
): NoteIdentityV1 | null {
  return sameNoteIdentity(current, prior) && isValidNoteIdentity(replacement)
    ? freezeNoteIdentity(replacement)
    : null;
}

function freezeIntent(intent: HostDispatchIntentV1): HostDispatchIntentV1 {
  return Object.freeze({ ...intent });
}

function freezeHistoryEntry(
  entry: ActionableHistoryEntrySnapshotV1["historyEntry"],
): ActionableHistoryEntrySnapshotV1["historyEntry"] {
  return Object.freeze({
    ...entry,
    forward: entry.forward,
    inverse: entry.inverse,
  });
}

export function freezeEntry(
  entry: ActionableHistoryEntrySnapshotV1,
): ActionableHistoryEntrySnapshotV1 {
  return Object.freeze({
    ...entry,
    historyEntry: freezeHistoryEntry(entry.historyEntry),
    noteIdentity: freezeNoteIdentity(entry.noteIdentity),
    preparedForward: freezeIntent(entry.preparedForward),
  });
}

export function freezeEnvelope(
  entry: ActionableHistoryEntrySnapshotV1,
  noteIdentity: NoteIdentityV1,
  direction: "forward" | "inverse",
): HostEffectEnvelopeV1 {
  return Object.freeze({
    direction,
    effectId: entry.effectId,
    historyEntryId: entry.historyEntry.historyEntryId,
    historyEpoch: entry.historyEntry.historyEpoch,
    noteIdentity: freezeNoteIdentity(noteIdentity),
  });
}

export function freezeAcknowledgement(
  editorViewId: ViewId,
  delivery: HostEffectDeliveryV1,
): HostEffectAcknowledgementV1 {
  return Object.freeze({
    direction: delivery.envelope.direction,
    editorViewId,
    effectId: delivery.envelope.effectId,
    transactionSequence: delivery.transactionSequence,
  });
}

export function matchesEntry(
  entry: ActionableHistoryEntrySnapshotV1,
  envelope: HostEffectEnvelopeV1,
  ownerViewId: ViewId,
): boolean {
  return (
    entry.effectId === envelope.effectId &&
    entry.historyEntry.historyEntryId === envelope.historyEntryId &&
    entry.historyEntry.historyEpoch === envelope.historyEpoch &&
    sameNoteIdentity(entry.noteIdentity, envelope.noteIdentity) &&
    entry.ownerViewId === ownerViewId
  );
}

export function sameEnvelope(
  left: HostEffectEnvelopeV1,
  right: HostEffectEnvelopeV1,
): boolean {
  return (
    left.effectId === right.effectId &&
    left.historyEntryId === right.historyEntryId &&
    left.historyEpoch === right.historyEpoch &&
    left.direction === right.direction &&
    sameNoteIdentity(left.noteIdentity, right.noteIdentity)
  );
}

export function editorEpochKey(
  editorViewId: ViewId,
  epoch: HistoryEpoch,
): string {
  return `${editorViewId}\u0000${String(epoch)}`;
}
