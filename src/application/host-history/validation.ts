import type {
  ActionableHistoryEntrySnapshotV1,
  HostDispatchIntentV1,
  HostEffectEnvelopeV1,
  HostHistoryLimitsV1,
  HostHistorySnapshotV1,
  NoteIdentityV1,
  ProbeAnnotationPatchV1,
} from "./types";

export const DEFAULT_HOST_HISTORY_LIMITS: HostHistoryLimitsV1 = Object.freeze({
  // The specification fixes the actionable table at 256 entries.
  maxActionableEntries: 256,
  // The specification fixes the per-pane payload budget at 32 MiB.
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  maxPayloadBytes: 32 * 1024 * 1024,
});

const MAX_ID_LENGTH = 128;
const MAX_IDENTITY_PART_LENGTH = 1024;
// Probe values stay deliberately smaller than the complete history budget.
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
const MAX_PROBE_VALUE_LENGTH = 64 * 1024;

export function sameNoteIdentity(
  left: NoteIdentityV1,
  right: NoteIdentityV1,
): boolean {
  return (
    left.vaultIdHint === right.vaultIdHint &&
    left.vaultRelativeMarkdownPath === right.vaultRelativeMarkdownPath
  );
}

function isValidNoteIdentity(value: NoteIdentityV1): boolean {
  return (
    isBoundedString(value.vaultIdHint, MAX_IDENTITY_PART_LENGTH) &&
    isBoundedString(value.vaultRelativeMarkdownPath, MAX_IDENTITY_PART_LENGTH)
  );
}

export function isValidEnvelope(value: HostEffectEnvelopeV1): boolean {
  return (
    isBoundedString(value.effectId, MAX_ID_LENGTH) &&
    isBoundedString(value.historyEntryId, MAX_ID_LENGTH) &&
    isPositiveCounter(value.historyEpoch) &&
    isValidNoteIdentity(value.noteIdentity)
  );
}

export function isValidPatch(value: ProbeAnnotationPatchV1): boolean {
  return (
    isNullableBoundedString(value.prior) &&
    isNullableBoundedString(value.replacement) &&
    value.prior !== value.replacement
  );
}

export function isPositiveCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function estimateEntryBytes(entry: ActionableHistoryEntrySnapshotV1): number {
  return JSON.stringify(entry).length;
}

export function fitsLimits(
  entries: readonly ActionableHistoryEntrySnapshotV1[],
  limits: HostHistoryLimitsV1,
): boolean {
  if (entries.length > limits.maxActionableEntries) return false;
  return (
    entries.reduce((total, entry) => total + estimateEntryBytes(entry), 0) <=
    limits.maxPayloadBytes
  );
}

export function isValidSnapshot(
  snapshot: HostHistorySnapshotV1,
  noteIdentity: NoteIdentityV1,
  limits: HostHistoryLimitsV1,
): boolean {
  if (
    !sameNoteIdentity(snapshot.noteIdentity, noteIdentity) ||
    !Number.isSafeInteger(snapshot.scene.revision) ||
    snapshot.scene.revision < 0 ||
    !isPositiveCounter(snapshot.nextEpoch) ||
    !fitsLimits(snapshot.entries, limits)
  ) {
    return false;
  }
  return (
    snapshot.entries.every((entry) => isValidEntry(entry, snapshot)) &&
    snapshot.highWaterMarks.every((mark) => isPositiveCounter(mark.sequence)) &&
    snapshot.acceptedDeliveries.every((delivery) =>
      isValidAcceptedDelivery(delivery.intent, delivery.envelope),
    )
  );
}

function isValidEntry(
  entry: ActionableHistoryEntrySnapshotV1,
  snapshot: HostHistorySnapshotV1,
): boolean {
  const envelope: HostEffectEnvelopeV1 = {
    direction: "forward",
    effectId: entry.effectId,
    historyEntryId: entry.historyEntryId,
    historyEpoch: entry.historyEpoch,
    noteIdentity: snapshot.noteIdentity,
  };
  const ownedLease = snapshot.lease.kind === "owned" ? snapshot.lease : null;
  return (
    ownedLease !== null &&
    ownedLease.ownerViewId === entry.ownerViewId &&
    ownedLease.epoch === entry.historyEpoch &&
    isValidEnvelope(envelope) &&
    isValidPatch(entry.patch) &&
    isValidIntent(entry.preparedForward, entry)
  );
}

function isValidIntent(
  intent: HostDispatchIntentV1,
  entry: ActionableHistoryEntrySnapshotV1,
): boolean {
  return (
    intent.historyEntryId === entry.historyEntryId &&
    intent.historyEpoch === entry.historyEpoch &&
    intent.direction === "forward" &&
    intent.patch.prior === entry.patch.prior &&
    intent.patch.replacement === entry.patch.replacement &&
    Number.isSafeInteger(intent.expectedSceneRevision) &&
    intent.expectedSceneRevision >= 0
  );
}

function isValidAcceptedDelivery(
  intent: HostDispatchIntentV1,
  envelope: HostEffectEnvelopeV1,
): boolean {
  return (
    isValidEnvelope(envelope) &&
    intent.historyEntryId === envelope.historyEntryId &&
    intent.historyEpoch === envelope.historyEpoch
  );
}

function isNullableBoundedString(value: string | null): boolean {
  return value === null || value.length <= MAX_PROBE_VALUE_LENGTH;
}

function isBoundedString(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum;
}
