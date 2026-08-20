import type {
  AcceptedDeliverySnapshotV1,
  ActionableHistoryEntrySnapshotV1,
  EditorEpochHighWaterSnapshotV1,
  HostHistoryLimitsV1,
  HostHistoryRestoreOptionsV1,
  HostHistorySnapshotV1,
  NoteIdentityV1,
} from "./types";
import { isValidSnapshot } from "./validation";
import { editorEpochKey } from "./value-objects";

export type HostHistoryRestoreResult =
  | { readonly kind: "blocked" }
  | { readonly kind: "empty" }
  | { readonly kind: "restored"; readonly snapshot: HostHistorySnapshotV1 };

export function restoreHostHistory(
  restore: HostHistoryRestoreOptionsV1,
  noteIdentity: NoteIdentityV1,
  limits: HostHistoryLimitsV1,
  entries: Map<string, ActionableHistoryEntrySnapshotV1>,
  accepted: Map<string, AcceptedDeliverySnapshotV1>,
  highWater: Map<string, EditorEpochHighWaterSnapshotV1>,
): HostHistoryRestoreResult {
  const snapshot = restore.snapshot;
  if (snapshot === undefined) {
    return { kind: restore.hostEffectsMayBeReachable ? "blocked" : "empty" };
  }
  let valid: boolean;
  try {
    valid = isValidSnapshot(snapshot, noteIdentity, limits);
  } catch {
    return { kind: "blocked" };
  }
  if (!valid) {
    return { kind: "blocked" };
  }
  for (const entry of snapshot.entries) entries.set(entry.effectId, entry);
  for (const delivery of snapshot.acceptedDeliveries) {
    accepted.set(
      editorEpochKey(delivery.editorViewId, delivery.historyEpoch),
      delivery,
    );
  }
  for (const mark of snapshot.highWaterMarks) {
    highWater.set(editorEpochKey(mark.editorViewId, mark.historyEpoch), mark);
  }
  return { kind: "restored", snapshot };
}
