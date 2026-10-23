import { canonicalPoint, rotatePointClockwise } from "../../../domain/geometry/public";
import type { PointV1 } from "../../../domain/schema/public";

interface ScaleFactors {
  readonly x: number;
  readonly y: number;
}

export function rotatedScaleTranslation(
  pivot: PointV1,
  worldAnchor: PointV1,
  localAnchor: PointV1,
  rotation: number,
  factors: ScaleFactors,
): PointV1 {
  // Stored geometry is unrotated, while the live SVG scale is anchored in world space.
  const localPivot = scalePoint(pivot, localAnchor, factors);
  const worldLocalPivot = rotatePointClockwise(pivot, worldAnchor, -rotation);
  const worldPivot = rotatePointClockwise(
    scalePoint(worldLocalPivot, worldAnchor, factors),
    worldAnchor,
    rotation,
  );
  return canonicalPoint({ x: worldPivot.x - localPivot.x, y: worldPivot.y - localPivot.y });
}

function scalePoint(point: PointV1, anchor: PointV1, factors: ScaleFactors): PointV1 {
  return {
    x: anchor.x + (point.x - anchor.x) * factors.x,
    y: anchor.y + (point.y - anchor.y) * factors.y,
  };
}
