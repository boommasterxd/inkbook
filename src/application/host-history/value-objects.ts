import type {
  ActionableHistoryEntrySnapshotV1,
  HistoryEpoch,
  HostDispatchIntentV1,
  HostEffectAcknowledgementV1,
  HostEffectDeliveryV1,
  HostEffectEnvelopeV1,
  HostHistoryCoordinatorConfigV1,
  HostHistoryLimitsV1,
  ProbeAnnotationPatchV1,
  ProbeSceneSnapshotV1,
  ViewId,
} from "./types";
import { DEFAULT_HOST_HISTORY_LIMITS, sameNoteIdentity } from "./validation";

export function resolveLimits(
  limits: HostHistoryCoordinatorConfigV1["limits"],
): HostHistoryLimitsV1 {
  return Object.freeze({
    maxActionableEntries:
      limits?.maxActionableEntries ??
      DEFAULT_HOST_HISTORY_LIMITS.maxActionableEntries,
    maxPayloadBytes:
      limits?.maxPayloadBytes ?? DEFAULT_HOST_HISTORY_LIMITS.maxPayloadBytes,
  });
}

export function freezeNoteIdentity(
  noteIdentity: HostEffectEnvelopeV1["noteIdentity"],
): HostEffectEnvelopeV1["noteIdentity"] {
  return Object.freeze({ ...noteIdentity });
}

export function freezePatch(
  patch: ProbeAnnotationPatchV1,
): ProbeAnnotationPatchV1 {
  return Object.freeze({ ...patch });
}

export function invertPatch(
  patch: ProbeAnnotationPatchV1,
): ProbeAnnotationPatchV1 {
  return Object.freeze({ prior: patch.replacement, replacement: patch.prior });
}

export function freezeScene(
  annotation: string | null,
  revision: number,
): ProbeSceneSnapshotV1 {
  return Object.freeze({ annotation, revision });
}

export function freezeIntent(
  intent: HostDispatchIntentV1,
): HostDispatchIntentV1 {
  return Object.freeze({ ...intent, patch: freezePatch(intent.patch) });
}

export function freezeEntry(
  entry: ActionableHistoryEntrySnapshotV1,
): ActionableHistoryEntrySnapshotV1 {
  return Object.freeze({
    ...entry,
    patch: freezePatch(entry.patch),
    preparedForward: freezeIntent(entry.preparedForward),
  });
}

export function freezeEnvelope(
  entry: ActionableHistoryEntrySnapshotV1,
  noteIdentity: HostEffectEnvelopeV1["noteIdentity"],
  direction: "forward" | "inverse",
): HostEffectEnvelopeV1 {
  return Object.freeze({
    direction,
    effectId: entry.effectId,
    historyEntryId: entry.historyEntryId,
    historyEpoch: entry.historyEpoch,
    noteIdentity: freezeNoteIdentity(noteIdentity),
  });
}

export function freezeAcknowledgement(
  editorViewId: ViewId,
  ownerViewId: ViewId,
  delivery: HostEffectDeliveryV1,
): HostEffectAcknowledgementV1 {
  return Object.freeze({
    direction: delivery.envelope.direction,
    editorViewId,
    effectId: delivery.envelope.effectId,
    ownerViewId,
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
    entry.historyEntryId === envelope.historyEntryId &&
    entry.historyEpoch === envelope.historyEpoch &&
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
