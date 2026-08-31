import {
  canonicalPoint,
  linearPivot,
  quadraticPoint,
  rotatePointClockwise,
} from "../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../domain/schema/public";

const DEFAULT_STRAIGHT_TOLERANCE = 0.001;

export interface LinearBendSnapGuide {
  readonly alignment: "straight" | "symmetric";
  readonly curvePoint: PointV1;
  readonly end: PointV1;
  readonly start: PointV1;
}

export function editLinearBend(element: InkElementV1, bend: PointV1 | null): InkElementV1 {
  if (element.kind !== "line" && element.kind !== "arrow") {
    throw new TypeError("Only lines and arrows support bend editing.");
  }
  if (bend !== null) assertFinitePoint(bend);
  const canonicalBend = normalizeLinearBend(element.start, element.end, bend);
  return {
    ...element,
    bend: canonicalBend,
    pivot: linearPivot(element.start, element.end, canonicalBend),
  };
}

export function editLinearBendFromCurvePoint(
  element: InkElementV1,
  curvePoint: PointV1,
  snapTolerance = DEFAULT_STRAIGHT_TOLERANCE,
): InkElementV1 {
  if (element.kind !== "line" && element.kind !== "arrow") {
    throw new TypeError("Only lines and arrows support bend editing.");
  }
  assertFinitePoint(curvePoint);
  assertStraightTolerance(snapTolerance);
  const worldStart = rotatePointClockwise(element.start, element.pivot, element.rotation);
  const worldEnd = rotatePointClockwise(element.end, element.pivot, element.rotation);
  const snap = resolveCurvePointSnap(curvePoint, worldStart, worldEnd, snapTolerance);
  const worldControl =
    snap.kind === "straight"
      ? null
      : {
          x: 2 * snap.point.x - (worldStart.x + worldEnd.x) / 2,
          y: 2 * snap.point.y - (worldStart.y + worldEnd.y) / 2,
        };
  return editLinearFromWorld(element, worldStart, worldEnd, worldControl);
}

export function linearBendSnapGuide(
  element: InkElementV1,
  curvePoint: PointV1,
  snapTolerance = DEFAULT_STRAIGHT_TOLERANCE,
): LinearBendSnapGuide | null {
  if (element.kind !== "line" && element.kind !== "arrow") {
    throw new TypeError("Only lines and arrows support bend editing.");
  }
  assertFinitePoint(curvePoint);
  assertStraightTolerance(snapTolerance);
  const start = rotatePointClockwise(element.start, element.pivot, element.rotation);
  const end = rotatePointClockwise(element.end, element.pivot, element.rotation);
  const snap = resolveCurvePointSnap(curvePoint, start, end, snapTolerance);
  return snap.kind === "none" ? null : { alignment: snap.kind, curvePoint: snap.point, end, start };
}

export function normalizeLinearBend(
  start: PointV1,
  end: PointV1,
  bend: PointV1 | null,
  straightTolerance = DEFAULT_STRAIGHT_TOLERANCE,
): PointV1 | null {
  if (bend === null) return null;
  assertFinitePoint(bend);
  assertStraightTolerance(straightTolerance);
  const curvePoint = quadraticPoint(start, bend, end, 0.5);
  return pointToSegmentDistance(curvePoint, start, end) <= straightTolerance
    ? null
    : canonicalPoint(bend);
}

function editLinearFromWorld(
  element: Extract<InkElementV1, { kind: "arrow" | "line" }>,
  worldStart: PointV1,
  worldEnd: PointV1,
  worldControl: PointV1 | null,
): InkElementV1 {
  if (element.rotation === 0) return editLinearBend(element, worldControl);
  const origin = { x: 0, y: 0 };
  const uncenteredStart = rotatePointClockwise(worldStart, origin, -element.rotation);
  const uncenteredEnd = rotatePointClockwise(worldEnd, origin, -element.rotation);
  const uncenteredControl =
    worldControl === null ? null : rotatePointClockwise(worldControl, origin, -element.rotation);
  const uncenteredPivot = linearPivot(uncenteredStart, uncenteredEnd, uncenteredControl);
  const pivot = canonicalPoint(rotatePointClockwise(uncenteredPivot, origin, element.rotation));
  return {
    ...element,
    bend:
      worldControl === null
        ? null
        : canonicalPoint(rotatePointClockwise(worldControl, pivot, -element.rotation)),
    end: canonicalPoint(rotatePointClockwise(worldEnd, pivot, -element.rotation)),
    pivot,
    start: canonicalPoint(rotatePointClockwise(worldStart, pivot, -element.rotation)),
  };
}

function pointToSegmentDistance(point: PointV1, start: PointV1, end: PointV1): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared;
  const time = Math.max(0, Math.min(1, projection));
  return Math.hypot(point.x - (start.x + time * deltaX), point.y - (start.y + time * deltaY));
}

function snapCurvePointToMidline(
  point: PointV1,
  start: PointV1,
  end: PointV1,
  tolerance: number,
): PointV1 {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const length = Math.hypot(deltaX, deltaY);
  if (length === 0) return point;
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const along = ((point.x - midpoint.x) * deltaX + (point.y - midpoint.y) * deltaY) / length;
  if (Math.abs(along) > tolerance) return point;
  return {
    x: point.x - (along * deltaX) / length,
    y: point.y - (along * deltaY) / length,
  };
}

function resolveCurvePointSnap(
  point: PointV1,
  start: PointV1,
  end: PointV1,
  tolerance: number,
): { readonly kind: "none" | "straight" | "symmetric"; readonly point: PointV1 } {
  if (pointToSegmentDistance(point, start, end) <= tolerance) {
    return {
      kind: "straight",
      point: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    };
  }
  const snapped = snapCurvePointToMidline(point, start, end, tolerance);
  return snapped.x === point.x && snapped.y === point.y
    ? { kind: "none", point }
    : { kind: "symmetric", point: snapped };
}

function assertStraightTolerance(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Straight bend tolerance must be non-negative and finite.");
  }
}

function assertFinitePoint(point: PointV1): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError("Point coordinates must be finite.");
  }
}
