import { pointDistance, rotatePointClockwise } from "../../domain/geometry/public";
import type { BoxAnchorV1, InkElementV1, PointV1 } from "../../domain/schema/public";

export function activeScaleAxes(position: BoxAnchorV1): {
  readonly x: boolean;
  readonly y: boolean;
} {
  return {
    x: position.includes("left") || position.includes("right"),
    y: position.startsWith("top") || position.startsWith("bottom"),
  };
}

export function canonicalHandlePoint(
  element: Pick<InkElementV1, "pivot" | "rotation">,
  point: PointV1,
): PointV1 {
  return rotatePointClockwise(point, element.pivot, -element.rotation);
}

export function clampEndpoint(point: PointV1, opposite: PointV1): PointV1 {
  const distance = pointDistance(point, opposite);
  if (distance >= 8) return point;
  if (distance === 0) return { x: opposite.x + 8, y: opposite.y };
  return {
    x: opposite.x + ((point.x - opposite.x) * 8) / distance,
    y: opposite.y + ((point.y - opposite.y) * 8) / distance,
  };
}
