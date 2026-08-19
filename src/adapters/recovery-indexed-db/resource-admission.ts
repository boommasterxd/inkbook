import {
  RESOURCE_CATEGORIES_V1,
  type BatchResourceHandleV1,
  type ResourceCoordinatorV1,
} from "../../application/resource-coordinator";

const OPERATION_CONTINUATIONS = 12;
const OPERATION_LISTENERS = 10;
const PROBE_CONTINUATIONS = 16;
const PROBE_LISTENERS = 8;
// Binary-kibibyte resource charges are part of RESOURCE_CHARGE_V1.
const KIB = 1_024;
const PROBE_KIB = 64;
const PROBE_BYTES = PROBE_KIB * KIB;
const PROBE_COMPLETION_BYTES = KIB;

export interface RecoveryResourceCharge {
  readonly completionBytes: number;
  readonly ownerId: string;
  readonly persistenceBytes: number;
  readonly queuedBytes: number;
  readonly scopeId: string;
}

export type RecoveryQueueReservation = BatchResourceHandleV1;

export function admitRecoveryQueueOperation(
  coordinator: ResourceCoordinatorV1,
  charge: RecoveryResourceCharge,
): RecoveryQueueReservation | null {
  const scope = { id: charge.scopeId, kind: "session" as const };
  const result = coordinator.admitBatch({
    completionBytes: charge.completionBytes,
    operations: [
      {
        bytes: 0,
        category: RESOURCE_CATEGORIES_V1.indexedDbQueueTurn,
        count: 1,
        ownerId: charge.ownerId,
        residency: "transient",
        scope,
      },
      {
        bytes: charge.queuedBytes,
        category: RESOURCE_CATEGORIES_V1.sessionTurn,
        count: 1,
        ownerId: charge.ownerId,
        residency: "transient",
        scope,
      },
      {
        bytes: 0,
        category: RESOURCE_CATEGORIES_V1.asyncContinuation,
        count: OPERATION_CONTINUATIONS,
        ownerId: charge.ownerId,
        residency: "transient",
        scope,
      },
      {
        bytes: 0,
        category: RESOURCE_CATEGORIES_V1.listener,
        count: OPERATION_LISTENERS,
        ownerId: charge.ownerId,
        residency: "transient",
        scope,
      },
      {
        bytes: charge.persistenceBytes,
        category: RESOURCE_CATEGORIES_V1.persistencePipeline,
        count: 1,
        ownerId: charge.ownerId,
        residency: "transient",
        scope,
      },
    ],
  });
  return result.kind === "admitted" ? result.handle : null;
}

export function admitProbeResources(
  coordinator: ResourceCoordinatorV1,
  ownerId: string,
): BatchResourceHandleV1 | null {
  const scope = { id: ownerId, kind: "session" as const };
  const result = coordinator.admitBatch({
    completionBytes: PROBE_COMPLETION_BYTES,
    operations: [
      {
        bytes: 0,
        category: RESOURCE_CATEGORIES_V1.indexedDbQueueTurn,
        count: 1,
        ownerId,
        residency: "transient",
        scope,
      },
      {
        bytes: PROBE_BYTES,
        category: RESOURCE_CATEGORIES_V1.sessionTurn,
        count: 1,
        ownerId,
        residency: "transient",
        scope,
      },
      {
        bytes: 0,
        category: RESOURCE_CATEGORIES_V1.asyncContinuation,
        count: PROBE_CONTINUATIONS,
        ownerId,
        residency: "transient",
        scope,
      },
      {
        bytes: 0,
        category: RESOURCE_CATEGORIES_V1.listener,
        count: PROBE_LISTENERS,
        ownerId,
        residency: "transient",
        scope,
      },
      {
        bytes: PROBE_BYTES,
        category: RESOURCE_CATEGORIES_V1.persistencePipeline,
        count: 1,
        ownerId,
        residency: "transient",
        scope,
      },
    ],
  });
  if (result.kind !== "admitted") return null;
  result.handle.activate();
  return result.handle;
}

export function admitStoreListener(
  coordinator: ResourceCoordinatorV1,
  ownerId: string,
): BatchResourceHandleV1 | null {
  const result = coordinator.admitBatch({
    operations: [
      {
        bytes: 0,
        category: RESOURCE_CATEGORIES_V1.listener,
        count: 1,
        ownerId,
        residency: "steady",
      },
    ],
  });
  if (result.kind !== "admitted") return null;
  result.handle.activate();
  return result.handle;
}

export function completeProbeResources(
  resources: BatchResourceHandleV1,
  ownerId: string,
): void {
  if (resources.state === "active") {
    resources.publishCompletion(`${ownerId}:completion`);
  }
  resources.release();
}

export function completeRecoveryReservation(
  reservation: RecoveryQueueReservation,
  ownerId: string,
  retainCompletion: boolean,
): (() => boolean) | null {
  if (reservation.state === "active") {
    reservation.publishCompletion(`${ownerId}:completion`);
  }
  if (retainCompletion && reservation.state === "completion") {
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      return reservation.release();
    };
  }
  reservation.release();
  return null;
}
