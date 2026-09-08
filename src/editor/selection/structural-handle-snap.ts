import { defaultTableHeaderHeight, rotatePointClockwise } from "../../domain/geometry/public";
import type {
  CoordinateSystemElementV1,
  PointV1,
  TableElementV1,
} from "../../domain/schema/public";

import { resolvePointAngleSnap } from "./angular-snap";

interface HandleSnapResult {
  readonly point: PointV1;
  readonly snapped: boolean;
}

export interface CoordinateOriginSnapResult extends HandleSnapResult {
  readonly additionalReferences: readonly PointV1[];
  readonly axisIndex: number | null;
  readonly reference: PointV1 | null;
}

export function resolveCoordinateAxisSnap(
  element: CoordinateSystemElementV1,
  pointer: PointV1,
  snapPixels: number,
  zoom: number,
): HandleSnapResult {
  const origin = rotatePointClockwise(element.origin, element.pivot, element.rotation);
  const result = resolvePointAngleSnap({
    origin,
    point: pointer,
    snapPixels,
    stepDegrees: 45,
    zoom,
  });
  return { point: result.point, snapped: result.snapped };
}

export function resolveCoordinateOriginSnap(
  element: CoordinateSystemElementV1,
  pointer: PointV1,
  snapPixels: number,
  zoom: number,
): CoordinateOriginSnapResult {
  let best: CoordinateOriginSnapResult = {
    additionalReferences: [],
    axisIndex: null,
    point: pointer,
    reference: null,
    snapped: false,
  };
  let bestDistance = Number.POSITIVE_INFINITY;
  element.axes.forEach((axis, axisIndex) => {
    const reference = rotatePointClockwise(axis, element.pivot, element.rotation);
    const result = resolvePointAngleSnap({
      origin: reference,
      point: pointer,
      snapPixels,
      stepDegrees: 45,
      zoom,
    });
    if (!result.snapped) return;
    const distance = Math.hypot(result.point.x - pointer.x, result.point.y - pointer.y);
    if (distance >= bestDistance) return;
    bestDistance = distance;
    best = {
      additionalReferences: [],
      axisIndex,
      point: result.point,
      reference,
      snapped: true,
    };
  });
  if (!best.snapped) return best;
  const additionalReferences = element.axes.flatMap((axis, axisIndex) => {
    if (axisIndex === best.axisIndex) return [];
    const reference = rotatePointClockwise(axis, element.pivot, element.rotation);
    const result = resolvePointAngleSnap({
      origin: reference,
      point: best.point,
      snapPixels,
      stepDegrees: 45,
      zoom,
    });
    return result.snapped ? [reference] : [];
  });
  return { ...best, additionalReferences };
}

export function resolveTableHeaderSnap(
  element: TableElementV1,
  localPointer: PointV1,
  tolerance: number,
): HandleSnapResult {
  const standard = element.y + defaultTableHeaderHeight(element.height);
  const snapped = Math.abs(localPointer.y - standard) <= tolerance;
  return {
    point: { x: localPointer.x, y: snapped ? standard : localPointer.y },
    snapped,
  };
}

export function resolveTableColumnSnap(
  element: TableElementV1,
  separatorIndex: number,
  localPointer: PointV1,
  tolerance: number,
): HandleSnapResult {
  const standard = element.x + (separatorIndex + 1) * element.columnWidth;
  const snapped = Math.abs(localPointer.x - standard) <= tolerance;
  return {
    point: { x: snapped ? standard : localPointer.x, y: localPointer.y },
    snapped,
  };
}
