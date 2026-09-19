import { canonicalPoint } from "../../domain/geometry/public";
import type { PointV1 } from "../../domain/schema/public";

export const ANGULAR_SNAP_MINIMUM_LENGTH_CSS_PIXELS = 8;

export interface PointAngleSnapResult {
  readonly angle: number;
  readonly point: PointV1;
  readonly snapped: boolean;
}

interface PointAngleSnapInput {
  readonly origin: PointV1;
  readonly point: PointV1;
  readonly snapPixels: number;
  readonly stepDegrees: number;
  readonly zoom: number;
}

export function resolvePointAngleSnap(input: PointAngleSnapInput): PointAngleSnapResult {
  const delta = { x: input.point.x - input.origin.x, y: input.point.y - input.origin.y };
  const radius = Math.hypot(delta.x, delta.y);
  if (
    radius * input.zoom < ANGULAR_SNAP_MINIMUM_LENGTH_CSS_PIXELS ||
    !Number.isFinite(input.zoom) ||
    input.zoom <= 0 ||
    !Number.isFinite(input.stepDegrees) ||
    input.stepDegrees <= 0 ||
    !Number.isFinite(input.snapPixels) ||
    input.snapPixels < 0
  ) {
    return { angle: 0, point: input.point, snapped: false };
  }
  const rawAngle = (Math.atan2(delta.y, delta.x) * 180) / Math.PI;
  const angle = Math.round(rawAngle / input.stepDegrees) * input.stepDegrees;
  const radians = (angle * Math.PI) / 180;
  const point = canonicalPoint({
    x: input.origin.x + Math.cos(radians) * radius,
    y: input.origin.y + Math.sin(radians) * radius,
  });
  const screenDistance = Math.hypot(point.x - input.point.x, point.y - input.point.y) * input.zoom;
  return screenDistance <= input.snapPixels
    ? { angle, point, snapped: true }
    : { angle: rawAngle, point: input.point, snapped: false };
}
