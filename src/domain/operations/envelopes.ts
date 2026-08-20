import { createSceneRevision } from "../model/index";
import { isHistoryEntryId, isHistoryEpoch, isOperationId } from "./identity";
import { invertAnnotationPatchV1 } from "./inverse";
import { hasExclusiveComponentChangesV1 } from "./batch-validation";
import { validateAnnotationPatchV1 } from "./patch-validation";
import type {
  AnnotationHistoryEntryV1,
  AnnotationOperationV1,
  AnnotationPatchResultV1,
} from "./types";
import { canonicalValueEqualsV1, hasExactKeysV1 } from "./value-equality";

export interface AnnotationHistoryEntrySourceV1 {
  readonly historyEntryId: unknown;
  readonly historyEpoch: unknown;
  readonly forward: unknown;
}

export function createAnnotationHistoryEntryV1(
  source: AnnotationHistoryEntrySourceV1,
): AnnotationPatchResultV1<AnnotationHistoryEntryV1> {
  if (
    !hasExactKeysV1(source, ["forward", "historyEntryId", "historyEpoch"]) ||
    !isHistoryEntryId(source.historyEntryId) ||
    !isHistoryEpoch(source.historyEpoch)
  ) {
    return Object.freeze({ ok: false, code: "invalid-operation" });
  }
  const forward = validateAnnotationPatchV1(source.forward);
  if (!forward.ok) return forward;
  if (!hasExclusiveComponentChangesV1(forward.value)) {
    return Object.freeze({ ok: false, code: "invalid-operation" });
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      historyEntryId: source.historyEntryId,
      historyEpoch: source.historyEpoch,
      forward: forward.value,
      inverse: invertAnnotationPatchV1(forward.value),
    }),
  });
}

export function validateAnnotationHistoryEntryV1(
  value: unknown,
): AnnotationPatchResultV1<AnnotationHistoryEntryV1> {
  if (
    !hasExactKeysV1(value, [
      "forward",
      "historyEntryId",
      "historyEpoch",
      "inverse",
    ])
  ) {
    return Object.freeze({ ok: false, code: "invalid-operation" });
  }
  const created = createAnnotationHistoryEntryV1({
    historyEntryId: value.historyEntryId,
    historyEpoch: value.historyEpoch,
    forward: value.forward,
  });
  if (!created.ok) return created;
  const inverse = validateAnnotationPatchV1(value.inverse);
  if (
    !inverse.ok ||
    !canonicalValueEqualsV1(created.value.inverse, inverse.value)
  ) {
    return Object.freeze({ ok: false, code: "invalid-operation" });
  }
  return created;
}

export function createAnnotationOperationV1(
  value: unknown,
): AnnotationPatchResultV1<AnnotationOperationV1> {
  if (
    !hasExactKeysV1(value, [
      "direction",
      "expectedSceneRevision",
      "historyEntryId",
      "historyEpoch",
      "operationId",
      "patch",
    ]) ||
    !isOperationId(value.operationId) ||
    !isHistoryEntryId(value.historyEntryId) ||
    !isHistoryEpoch(value.historyEpoch) ||
    (value.direction !== "forward" && value.direction !== "inverse") ||
    typeof value.expectedSceneRevision !== "number"
  ) {
    return Object.freeze({ ok: false, code: "invalid-operation" });
  }
  let expectedSceneRevision;
  try {
    expectedSceneRevision = createSceneRevision(value.expectedSceneRevision);
  } catch {
    return Object.freeze({ ok: false, code: "invalid-operation" });
  }
  const patch = validateAnnotationPatchV1(value.patch);
  if (!patch.ok) return patch;
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      operationId: value.operationId,
      historyEntryId: value.historyEntryId,
      direction: value.direction,
      expectedSceneRevision,
      historyEpoch: value.historyEpoch,
      patch: patch.value,
    }),
  });
}
