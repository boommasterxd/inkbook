import type {
  ActionableHistoryEntrySnapshotV1,
  HistoryEpoch,
  HostEffectDeliveryResultV1,
  HostHistoryFailureV1,
  HostHistoryLeaseSnapshotV1,
  PrepareHostEffectResultV1,
  ViewId,
} from "./types";

export type DeliveryValidationResult =
  | {
      readonly kind: "ready";
      readonly entry: ActionableHistoryEntrySnapshotV1;
      readonly key: string;
    }
  | { readonly kind: "complete"; readonly result: HostEffectDeliveryResultV1 };

export interface EntryTransition {
  readonly intent: import("./types").HostDispatchIntentV1;
  readonly lifecycle: "applied" | "undone";
  readonly recovery:
    | {
        readonly kind: "forward";
        readonly attemptId: import("../note-session").RecoveryAttemptId;
      }
    | {
        readonly kind: "direction";
        readonly attempt: Omit<
          import("../recovery").HostRecordedDirectionAttemptV1,
          "acknowledgement"
        >;
      };
}

export type OwnedLease = Extract<
  HostHistoryLeaseSnapshotV1,
  { readonly kind: "owned" }
>;

export type ProspectiveLeaseResult =
  | { readonly kind: "accepted"; readonly lease: OwnedLease }
  | { readonly kind: "rejected"; readonly reason: HostHistoryFailureV1 };

export function rejectPrepare(
  reason: HostHistoryFailureV1,
): PrepareHostEffectResultV1 {
  return Object.freeze({ kind: "rejected", reason });
}

export function rejectDelivery(
  reason: HostHistoryFailureV1,
): HostEffectDeliveryResultV1 {
  return Object.freeze({ kind: "rejected", reason });
}

export function invalidDelivery(
  reason: HostHistoryFailureV1,
): DeliveryValidationResult {
  return { kind: "complete", result: rejectDelivery(reason) };
}

export function prospectiveLease(
  current: HostHistoryLeaseSnapshotV1,
  nextEpoch: number,
  viewId: ViewId,
  historyEpoch: HistoryEpoch,
): ProspectiveLeaseResult {
  if (current.kind === "owned") {
    if (current.ownerViewId !== viewId) {
      return { kind: "rejected", reason: "non-owner" };
    }
    return current.epoch === historyEpoch
      ? { kind: "accepted", lease: current }
      : { kind: "rejected", reason: "stale-epoch" };
  }
  if (current.kind === "blocked") {
    return { kind: "rejected", reason: "blocked" };
  }
  if (historyEpoch !== nextEpoch) {
    return { kind: "rejected", reason: "stale-epoch" };
  }
  if (nextEpoch === Number.MAX_SAFE_INTEGER) {
    return { kind: "rejected", reason: "payload-limit" };
  }
  return {
    kind: "accepted",
    lease: Object.freeze({
      epoch: historyEpoch,
      kind: "owned",
      ownerViewId: viewId,
    }),
  };
}
