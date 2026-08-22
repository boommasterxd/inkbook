import type { InkElementV1, InkSnapshotV1, PageV1 } from "../../../domain/schema/public";
import type { CoalescedExportPlan } from "../../worker/coalesced-export";
import type { ExportRequest } from "../../worker/protocol";
import type {
  DocumentRuntimeResult,
  ModelSyncRuntimeRequest,
  ModelSyncRuntimeSuccess,
} from "../../worker/runtime/public";
import { sameOperationIdentity } from "./verification";

export type ConcreteExportRequest = ExportRequest<InkElementV1, PageV1, InkSnapshotV1>;

export interface ExportDispatchIdentity {
  readonly exportGeneration: number;
  readonly sessionId: string;
  readonly workerEpoch: number;
}

export function createExportRequest(
  plan: CoalescedExportPlan<InkElementV1, PageV1, InkSnapshotV1>,
  identity: ExportDispatchIdentity,
): ConcreteExportRequest {
  if (plan.type === "full") {
    return {
      ...identity,
      baseModelRevision: null,
      modelRevision: plan.modelRevision,
      snapshot: plan.snapshot,
      type: "export-full",
    };
  }
  return {
    ...identity,
    baseModelRevision: plan.baseModelRevision,
    ...incrementalPayload(plan),
    modelRevision: plan.modelRevision,
    type: "export-incremental",
  };
}

export function createModelSyncRequest(
  plan: CoalescedExportPlan<InkElementV1, PageV1, InkSnapshotV1>,
  identity: ModelSyncRuntimeRequest["identity"],
): ModelSyncRuntimeRequest {
  return plan.type === "full"
    ? {
        baseModelRevision: null,
        identity,
        modelRevision: plan.modelRevision,
        snapshot: plan.snapshot,
        type: "model-sync-full",
      }
    : {
        baseModelRevision: plan.baseModelRevision,
        identity,
        ...incrementalPayload(plan),
        modelRevision: plan.modelRevision,
        type: "model-sync-incremental",
      };
}

export function matchesExportResult(
  request: ConcreteExportRequest,
  result: {
    readonly exportGeneration: number;
    readonly modelRevision: number;
    readonly sessionId: string;
    readonly workerEpoch: number;
  },
): boolean {
  return (
    result.sessionId === request.sessionId &&
    result.workerEpoch === request.workerEpoch &&
    result.exportGeneration === request.exportGeneration &&
    result.modelRevision === request.modelRevision
  );
}

export function matchesModelSyncResult(
  request: ModelSyncRuntimeRequest,
  result: DocumentRuntimeResult,
): result is ModelSyncRuntimeSuccess {
  return (
    result.type === "model-sync-success" &&
    result.modelRevision === request.modelRevision &&
    sameOperationIdentity(result.identity, request.identity)
  );
}

function incrementalPayload(
  plan: Extract<CoalescedExportPlan<InkElementV1, PageV1, InkSnapshotV1>, { type: "incremental" }>,
) {
  return {
    ...(plan.changedElements.length === 0 ? {} : { changedElements: plan.changedElements }),
    ...(Object.keys(plan.orderChanges).length === 0 ? {} : { orderChanges: plan.orderChanges }),
    ...(plan.removedIds.length === 0 ? {} : { removedIds: plan.removedIds }),
    ...(plan.page === undefined ? {} : { page: plan.page }),
  };
}
