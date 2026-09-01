import { normalizeRotation, pointDistance } from "../../domain/geometry/public";
import type { PointV1 } from "../../domain/schema/public";

const RIGHT_ANGLE_DEGREES = 90;
const DEGREES_TO_RADIANS = Math.PI / 180;

interface SnappedRotationInput {
  readonly center: PointV1;
  readonly currentPointer: PointV1;
  readonly referenceRotation: number;
  readonly snapPixels: number;
  readonly startPointer: PointV1;
  readonly zoom: number;
  readonly enabled?: boolean;
}

export interface RotationSnapResult {
  readonly delta: number;
  readonly snapped: boolean;
  readonly targetRotation: number;
}

export function resolveRotationSnap(input: SnappedRotationInput): RotationSnapResult {
  const rawDelta = pointerRotation(input.center, input.startPointer, input.currentPointer);
  const radius = pointDistance(input.center, input.startPointer);
  const finalRotation = normalizeRotation(input.referenceRotation + rawDelta);
  if (radius === 0 || input.enabled === false) {
    return { delta: rawDelta, snapped: false, targetRotation: finalRotation };
  }
  const targetRotation = Math.round(finalRotation / RIGHT_ANGLE_DEGREES) * RIGHT_ANGLE_DEGREES;
  const correction = normalizeRotation(targetRotation - finalRotation);
  const correctionPixels = Math.abs(correction) * DEGREES_TO_RADIANS * radius * input.zoom;
  return correctionPixels <= input.snapPixels
    ? { delta: rawDelta + correction, snapped: true, targetRotation }
    : { delta: rawDelta, snapped: false, targetRotation: finalRotation };
}

function pointerRotation(center: PointV1, start: PointV1, current: PointV1): number {
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const currentAngle = Math.atan2(current.y - center.y, current.x - center.x);
  return ((currentAngle - startAngle) * 180) / Math.PI;
}
