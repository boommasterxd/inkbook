import type { PointV1 } from "../../schema/types";
import type { PressureCapsule } from "./pressure-joins";

export function pressureCapsuleContains(
  capsule: PressureCapsule,
  point: PointV1,
  includeBoundary = true,
): boolean {
  for (const nib of [capsule.start, capsule.end]) {
    const dx = point.x - nib.center.x;
    const dy = point.y - nib.center.y;
    const distanceSquared = dx * dx + dy * dy;
    const radiusSquared = nib.radius * nib.radius;
    if (includeBoundary ? distanceSquared <= radiusSquared : distanceSquared < radiusSquared)
      return true;
  }
  const vertices = [capsule.left.start, capsule.left.end, capsule.right.end, capsule.right.start];
  return vertices.every((start, index) => {
    const end = vertices[(index + 1) % 4]!;
    const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
    return includeBoundary ? cross <= 0 : cross < 0;
  });
}
