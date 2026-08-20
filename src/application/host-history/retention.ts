import type {
  AcceptedDeliverySnapshotV1,
  ActionableHistoryEntrySnapshotV1,
  EditorEpochHighWaterSnapshotV1,
  HostEffectDeliveryV1,
  HostDispatchIntentV1,
  HostTransactionSequence,
  HistoryEpoch,
  ViewId,
} from "./types";
import { invalidDelivery } from "./results";
import type { DeliveryValidationResult } from "./results";
import { sameEnvelope } from "./value-objects";

export function hasAdmittingEntry(
  entries: ReadonlyMap<string, ActionableHistoryEntrySnapshotV1>,
): boolean {
  return [...entries.values()].some((entry) => entry.lifecycle === "admitting");
}

export function hasHistoryIdentity(
  entries: ReadonlyMap<string, ActionableHistoryEntrySnapshotV1>,
  effectId: string,
  historyEntryId: string,
): boolean {
  return [...entries.values()].some(
    (entry) =>
      entry.effectId === effectId ||
      entry.historyEntry.historyEntryId === historyEntryId,
  );
}

export function releaseRedoBranch(
  entries: Map<string, ActionableHistoryEntrySnapshotV1>,
  currentEffectId: string,
  onRelease: ((entry: ActionableHistoryEntrySnapshotV1) => void) | undefined,
): void {
  for (const entry of [...entries.values()]) {
    if (entry.effectId !== currentEffectId && entry.lifecycle === "undone") {
      releaseEntry(entries, entry, onRelease);
    }
  }
}

export function releaseEntry(
  entries: Map<string, ActionableHistoryEntrySnapshotV1>,
  entry: ActionableHistoryEntrySnapshotV1,
  onRelease: ((entry: ActionableHistoryEntrySnapshotV1) => void) | undefined,
): void {
  entries.delete(entry.effectId);
  onRelease?.(entry);
}

export function acceptDelivery(
  highWater: Map<
    string,
    {
      readonly editorViewId: ViewId;
      readonly historyEpoch: HistoryEpoch;
      readonly sequence: HostTransactionSequence;
    }
  >,
  accepted: Map<string, AcceptedDeliverySnapshotV1>,
  key: string,
  editorViewId: ViewId,
  delivery: HostEffectDeliveryV1,
  intent: HostDispatchIntentV1,
): void {
  highWater.set(
    key,
    Object.freeze({
      editorViewId,
      historyEpoch: delivery.envelope.historyEpoch,
      sequence: delivery.transactionSequence,
    }),
  );
  accepted.set(
    key,
    Object.freeze({
      editorViewId,
      envelope: delivery.envelope,
      historyEpoch: delivery.envelope.historyEpoch,
      intent,
      sequence: delivery.transactionSequence,
    }),
  );
}

export function releaseEpochDeliveryState(
  accepted: Map<string, AcceptedDeliverySnapshotV1>,
  highWater: Map<string, EditorEpochHighWaterSnapshotV1>,
  historyEpoch: HistoryEpoch,
): void {
  for (const [key, delivery] of accepted) {
    if (delivery.historyEpoch === historyEpoch) accepted.delete(key);
  }
  for (const [key, mark] of highWater) {
    if (mark.historyEpoch === historyEpoch) highWater.delete(key);
  }
}

export function clearDeliveryState(
  accepted: Map<string, AcceptedDeliverySnapshotV1>,
  highWater: Map<string, EditorEpochHighWaterSnapshotV1>,
): void {
  accepted.clear();
  highWater.clear();
}

export function validateSequence(
  highWater: ReadonlyMap<
    string,
    {
      readonly sequence: HostTransactionSequence;
    }
  >,
  accepted: ReadonlyMap<string, AcceptedDeliverySnapshotV1>,
  key: string,
  delivery: HostEffectDeliveryV1,
  scene: import("../../domain/scene").RuntimeSceneStateV1,
): DeliveryValidationResult | null {
  const mark = highWater.get(key);
  if (mark === undefined || delivery.transactionSequence > mark.sequence) {
    return null;
  }
  if (delivery.transactionSequence < mark.sequence) {
    return invalidDelivery("stale-sequence");
  }
  const acceptedDelivery = accepted.get(key);
  if (
    acceptedDelivery !== undefined &&
    sameEnvelope(acceptedDelivery.envelope, delivery.envelope)
  ) {
    return {
      kind: "complete",
      result: Object.freeze({
        intent: acceptedDelivery.intent,
        kind: "duplicate",
        scene,
      }),
    };
  }
  return invalidDelivery("out-of-order");
}
