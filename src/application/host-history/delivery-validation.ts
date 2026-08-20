import type { RuntimeSceneStateV1 } from "../../domain/scene";
import type {
  AcceptedDeliverySnapshotV1,
  ActionableHistoryEntrySnapshotV1,
  EditorEpochHighWaterSnapshotV1,
  HostEffectDeliveryV1,
  HostHistoryFailureV1,
  HostHistoryLeaseSnapshotV1,
  ViewId,
} from "./types";
import { isPositiveCounter, isValidEnvelope } from "./validation";
import { editorEpochKey, matchesEntry } from "./value-objects";
import { invalidDelivery, type DeliveryValidationResult } from "./results";
import { validateSequence } from "./retention";

interface DeliveryValidationContextV1 {
  readonly accepted: ReadonlyMap<string, AcceptedDeliverySnapshotV1>;
  readonly entries: ReadonlyMap<string, ActionableHistoryEntrySnapshotV1>;
  readonly highWater: ReadonlyMap<string, EditorEpochHighWaterSnapshotV1>;
  readonly lease: HostHistoryLeaseSnapshotV1;
  readonly scene: RuntimeSceneStateV1;
  readonly unavailable: HostHistoryFailureV1 | null;
}

export function validateHostHistoryDeliveryV1(
  context: DeliveryValidationContextV1,
  editorViewId: ViewId,
  ownerViewId: ViewId,
  delivery: HostEffectDeliveryV1,
): DeliveryValidationResult {
  if (context.unavailable !== null) return invalidDelivery(context.unavailable);
  if (!isValidEnvelope(delivery.envelope))
    return invalidDelivery("invalid-envelope");
  if (!isPositiveCounter(delivery.transactionSequence))
    return invalidDelivery("invalid-sequence");
  if (context.lease.kind !== "owned") return invalidDelivery("stale-epoch");
  if (context.lease.epoch !== delivery.envelope.historyEpoch)
    return invalidDelivery("stale-epoch");
  if (context.lease.ownerViewId !== ownerViewId)
    return invalidDelivery("non-owner");
  const entry = context.entries.get(delivery.envelope.effectId);
  if (entry === undefined) return invalidDelivery("entry-not-found");
  if (!matchesEntry(entry, delivery.envelope, ownerViewId))
    return invalidDelivery("invalid-envelope");
  const key = editorEpochKey(editorViewId, delivery.envelope.historyEpoch);
  const sequenceResult = validateSequence(
    context.highWater,
    context.accepted,
    key,
    delivery,
    context.scene,
  );
  if (sequenceResult !== null) return sequenceResult;
  return { entry, key, kind: "ready" };
}
