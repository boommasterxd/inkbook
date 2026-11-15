import type { PointV1 } from "../../../../domain/schema/public";
import type { SpatialBounds } from "../../../../domain/spatial/index";

/** One screen-space outline marks the fixed part of a selection without edit handles. */
export function lockedSelectionOutline(
  bounds: SpatialBounds | undefined,
  project: (point: PointV1) => PointV1,
): string | null {
  if (bounds === undefined) return null;
  const top = project({ x: bounds.minX, y: bounds.minY });
  const bottom = project({ x: bounds.maxX, y: bounds.maxY });
  const left = String(top.x);
  const right = String(bottom.x);
  const y = String(top.y);
  const low = String(bottom.y);
  const x = top.x + 8;
  const lockY = top.y + 8;
  return [
    `M ${left} ${y} H ${right} V ${low} H ${left} Z`,
    `M ${String(x)} ${String(lockY + 5)} h 10 v 8 h -10 Z`,
    `M ${String(x + 2)} ${String(lockY + 5)} v -2 a 3 3 0 0 1 6 0 v 2`,
  ].join(" ");
}
