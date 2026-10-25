import { visitLocalAnchorPoints, type AnchorTargetView } from "./anchors";
import { tableWidth } from "./creation";
import {
  boundsContainPoint,
  canonicalPoint,
  rotatePointClockwise,
  type Bounds,
} from "./primitives";

/** Rejects anchor-free queries without allocating semantic-anchor identifiers or cached DTOs. */
export function mayHaveAnchorInBounds(target: AnchorTargetView, bounds: Bounds): boolean {
  const localBounds = localQueryBounds(target, bounds);
  if (queryInsideBox(target, localBounds)) return false;
  return visitLocalAnchorPoints(target, (point) => {
    if (!boundsContainPoint(localBounds, point)) return false;
    return boundsContainPoint(
      bounds,
      canonicalPoint(rotatePointClockwise(point, target.pivot, target.rotation)),
    );
  });
}

function localQueryBounds(target: AnchorTargetView, bounds: Bounds): Bounds {
  const radians = (target.rotation * Math.PI) / 180;
  const cosine = target.rotation === 0 ? 1 : Math.cos(radians);
  const sine = target.rotation === 0 ? 0 : Math.sin(radians);
  const x = (bounds.minX + bounds.maxX) / 2 - target.pivot.x;
  const y = (bounds.minY + bounds.maxY) / 2 - target.pivot.y;
  const localX = target.pivot.x + x * cosine + y * sine;
  const localY = target.pivot.y - x * sine + y * cosine;
  // Rotated canonical anchors can move by half a 0.001-unit quantum on each axis.
  // Expanding by 0.001 before the inverse transform conservatively covers both axes.
  const halfWidth = (bounds.maxX - bounds.minX) / 2 + 0.001;
  const halfHeight = (bounds.maxY - bounds.minY) / 2 + 0.001;
  const extentX = halfWidth * Math.abs(cosine) + halfHeight * Math.abs(sine);
  const extentY = halfWidth * Math.abs(sine) + halfHeight * Math.abs(cosine);
  return {
    minX: localX - extentX,
    maxX: localX + extentX,
    minY: localY - extentY,
    maxY: localY + extentY,
  };
}

function queryInsideBox(target: AnchorTargetView, bounds: Bounds): boolean {
  if (target.kind !== "rectangle" && target.kind !== "table" && target.kind !== "ellipse")
    return false;
  const width = target.kind === "table" ? tableWidth(target) : target.width;
  return (
    bounds.minX > target.x &&
    bounds.maxX < target.x + width &&
    bounds.minY > target.y &&
    bounds.maxY < target.y + target.height
  );
}
