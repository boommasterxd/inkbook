import type {
  ActionableHistoryEntrySnapshotV1,
  HostDispatchIntentV1,
  HostEffectDeliveryResultV1,
  HostHistoryFailureV1,
  HostHistoryLeaseSnapshotV1,
  PrepareHostEffectResultV1,
} from "./types";

export type DeliveryValidationResult =
  | {
      readonly kind: "ready";
      readonly entry: ActionableHistoryEntrySnapshotV1;
      readonly key: string;
    }
  | { readonly kind: "complete"; readonly result: HostEffectDeliveryResultV1 };

export interface EntryTransition {
  readonly intent: HostDispatchIntentV1;
  readonly lifecycle: "applied" | "undone";
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
