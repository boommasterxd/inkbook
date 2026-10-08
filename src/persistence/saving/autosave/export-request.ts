import type { InkElementV1, InkSnapshotV1, PageV1 } from "../../../domain/schema/public";
import type { CoalescedExportPlan } from "../../worker/coalesced-export";
import type { ExportRequest } from "../../worker/protocol";
import type {
  DocumentRuntimeResult,
  ModelSyncRuntimeRequest,
  ModelSyncRuntimeSuccess,
} from "../../worker/runtime/public";
import { sameOperationIdentity } from "./verification";
import {
  MAX_PREPARED_PRESSURE_HINT_BYTES,
  MAX_PREPARED_PRESSURE_HINTS,
  preparedPressureHintBytes,
  type PreparedPressurePathHint,
} from "../../serialization/prepared-pressure-hints";

export type ConcreteExportRequest = ExportRequest<InkElementV1, PageV1, InkSnapshotV1>;

export interface ExportDispatchIdentity {
  readonly exportGeneration: number;
  readonly sessionId: string;
  readonly workerEpoch: number;
}

export function createExportRequest(
  plan: CoalescedExportPlan<InkElementV1, PageV1, InkSnapshotV1>,
  identity: ExportDispatchIdentity,
  readPreparedPressurePaths?: (
    modelRevision: number,
    changedIds?: ReadonlySet<string>,
  ) => Iterable<PreparedPressurePathHint>,
  includeBaselinePreparedPressurePaths = false,
): ConcreteExportRequest {
  const preparedPressurePaths = collectPreparedPressurePaths(
    plan,
    readPreparedPressurePaths,
    includeBaselinePreparedPressurePaths,
  );
  if (plan.type === "full") {
    return {
      ...identity,
      baseModelRevision: null,
      modelRevision: plan.modelRevision,
      ...(preparedPressurePaths.length === 0 ? {} : { preparedPressurePaths }),
      snapshot: plan.snapshot,
      type: "export-full",
    };
  }
  return {
    ...identity,
    baseModelRevision: plan.baseModelRevision,
    ...incrementalPayload(plan),
    ...(includeBaselinePreparedPressurePaths ? { includeBaselinePreparedPressurePaths: true } : {}),
    modelRevision: plan.modelRevision,
    ...(preparedPressurePaths.length === 0 ? {} : { preparedPressurePaths }),
    type: "export-incremental",
  };
}

function collectPreparedPressurePaths(
  plan: CoalescedExportPlan<InkElementV1, PageV1, InkSnapshotV1>,
  read:
    | ((
        modelRevision: number,
        changedIds?: ReadonlySet<string>,
      ) => Iterable<PreparedPressurePathHint>)
    | undefined,
  includeBaseline: boolean,
): readonly PreparedPressurePathHint[] {
  if (read === undefined) return [];
  const changed =
    plan.type === "full" || includeBaseline
      ? null
      : new Set(plan.changedElements.map((element) => element.id));
  if (changed?.size === 0) return [];
  const paths: PreparedPressurePathHint[] = [];
  const candidates = read(plan.modelRevision, changed ?? undefined);
  let bytes = 0;
  let visited = 0;
  for (const hint of candidates) {
    visited += 1;
    if (hint.modelRevision === plan.modelRevision && (changed === null || changed.has(hint.id))) {
      const size = preparedPressureHintBytes(hint);
      if (size <= MAX_PREPARED_PRESSURE_HINT_BYTES - bytes) {
        paths.push(hint);
        bytes += size;
      }
    }
    if (visited >= MAX_PREPARED_PRESSURE_HINTS) break;
  }
  return paths;
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
  currentEpoch = request.identity.workerEpoch,
): result is ModelSyncRuntimeSuccess {
  return (
    currentEpoch === request.identity.workerEpoch &&
    result.type === "model-sync-success" &&
    result.modelRevision === request.modelRevision &&
    sameOperationIdentity(result.identity, request.identity)
  );
}

function incrementalPayload(
  plan: Extract<CoalescedExportPlan<InkElementV1, PageV1, InkSnapshotV1>, { type: "incremental" }>,
) {
  return {
    ...(plan.changedElementDerivations === undefined
      ? {}
      : { changedElementDerivations: plan.changedElementDerivations }),
    ...(plan.changedElements.length === 0 ? {} : { changedElements: plan.changedElements }),
    ...(Object.keys(plan.orderChanges).length === 0 ? {} : { orderChanges: plan.orderChanges }),
    ...(plan.removedIds.length === 0 ? {} : { removedIds: plan.removedIds }),
    ...(plan.page === undefined ? {} : { page: plan.page }),
  };
}
