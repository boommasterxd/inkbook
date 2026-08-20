import type { SceneElementV1 } from "../model";
import type { GroupRecordV1 } from "../scene";
import { SCENE_RESOURCE_LIMITS_V1 } from "../scene/resource-limits";

type DataRecord = Record<string, unknown>;

export interface SceneAggregateAdmissionV1 {
  readonly records: number;
  readonly strokePoints: number;
}

export function admitSceneRecordCount(
  elements: readonly unknown[],
  groups: readonly unknown[],
): number {
  const records = elements.length + groups.length;
  if (records > SCENE_RESOURCE_LIMITS_V1.maxRecords) {
    throw new RangeError("Scene record count exceeds the V1 limit.");
  }
  return records;
}

function strokePointCount(candidate: unknown): number | null {
  const element = candidate as DataRecord;
  if (element.kind !== "pen" && element.kind !== "highlighter") return null;
  const geometry = element.geometry;
  if (geometry === null || typeof geometry !== "object") return null;
  const stroke = (geometry as DataRecord).stroke;
  if (stroke === null || typeof stroke !== "object") return null;
  const pointCount = (stroke as DataRecord).pointCount;
  if (!Number.isSafeInteger(pointCount) || (pointCount as number) < 0) {
    return null;
  }
  return pointCount as number;
}

export function admitSceneStrokePoints(
  elements: readonly unknown[],
  records: number,
): SceneAggregateAdmissionV1 {
  let strokePoints = 0;
  for (const candidate of elements) {
    const pointCount = strokePointCount(candidate);
    if (pointCount === null) continue;
    strokePoints += pointCount;
    if (strokePoints > SCENE_RESOURCE_LIMITS_V1.maxStrokePoints) {
      throw new RangeError("Aggregate stroke points exceed the V1 limit.");
    }
  }
  return Object.freeze({ records, strokePoints });
}

export function confirmSceneAggregate(
  elements: readonly SceneElementV1[],
  groups: readonly GroupRecordV1[],
  admitted: SceneAggregateAdmissionV1,
): void {
  let strokePoints = 0;
  for (const element of elements) {
    if (element.kind === "pen" || element.kind === "highlighter") {
      strokePoints += element.geometry.stroke.pointCount;
    }
  }
  if (
    elements.length + groups.length !== admitted.records ||
    strokePoints !== admitted.strokePoints
  ) {
    throw new TypeError("Validated scene aggregates changed after admission.");
  }
}
