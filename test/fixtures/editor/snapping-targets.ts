import { calculateElementBounds } from "../../../src/domain/geometry/public";
import { isAnchorTarget, semanticAnchors } from "../../../src/domain/geometry/anchors";
import { createBuiltInSettings } from "../../../src/domain/settings/defaults";
import { createDragElement } from "../../../src/editor/tools/public";
import type { PointV1 } from "../../../src/domain/schema/public";

export const SNAP_TARGET_FAMILIES = [
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "parallelogram",
  "octagon",
  "line",
  "arrow",
  "table",
  "coordinate2d",
  "coordinate3d",
] as const;

export function snappingTarget(
  family: (typeof SNAP_TARGET_FAMILIES)[number],
  rotation = 0,
  offset = 0,
) {
  const defaults = createBuiltInSettings().toolDefaults;
  const coordinate = family === "coordinate2d" || family === "coordinate3d";
  if (coordinate) defaults.coordinateSystem.dimension = family === "coordinate2d" ? "2d" : "3d";
  const element = createDragElement({
    defaults,
    identity: { createdAt: 1, id: "40000000-0000-4000-8000-000000000001" },
    tool: coordinate ? "coordinate-system" : family,
    start: { x: offset + 100.001, y: offset + 100.003 },
    end: { x: offset + 200.004, y: offset + 200.008 },
  });
  if (!isAnchorTarget(element)) throw new Error("Expected an anchor target.");
  return { ...element, rotation };
}

/** Chooses an interior miss using the real semantic anchors, outside measured query work. */
export function anchorFreePoint(target: ReturnType<typeof snappingTarget>): PointV1 {
  const bounds = calculateElementBounds(target);
  const anchors = semanticAnchors(target);
  let best: PointV1 = { x: 0, y: 0 };
  let maximumDistance = 0;
  for (let row = 1; row < 20; row += 1) {
    for (let column = 1; column < 20; column += 1) {
      const point = {
        x: bounds.minX + ((bounds.maxX - bounds.minX) * column) / 20,
        y: bounds.minY + ((bounds.maxY - bounds.minY) * row) / 20,
      };
      const distance = Math.min(
        ...anchors.map((anchor) => Math.hypot(point.x - anchor.point.x, point.y - anchor.point.y)),
      );
      if (distance > maximumDistance) {
        best = point;
        maximumDistance = distance;
      }
    }
  }
  if (maximumDistance <= 20) throw new Error("The fixture requires an anchor-free query radius.");
  return best;
}
