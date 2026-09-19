import { rotatePointClockwise } from "../../domain/geometry/public";
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
