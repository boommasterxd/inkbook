import type { PointV1 } from "../schema/types";
import { pointSegmentDistance } from "./primitives";
import { PRESSURE_PREPARATION_CHECK_INTERVAL } from "./pressure-union";
import { recordPressureAddition, type PressureAdditionRecorder } from "./pressure-additions";

interface Vertex {
  point: PointV1;
  source: number;
  anchor: boolean;
  previous: number;
  next: number;
  error: number;
}

interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Every rewrite adds only clockwise triangle winding. Unlike an unconstrained
 * chord approximation, it cannot erase ink through cancellation at overlaps.
 * Edge error accumulates across rewrites; endpoints and the original box stay fixed.
 * Original anchored chord checks can perform quadratic work inside a bounded window.
 */
export function* iteratePressureBoundarySimplification(
  points: readonly PointV1[],
  tolerance: number,
  addedTriangle?: PressureAdditionRecorder,
): Generator<void, PointV1[]> {
  if (!Number.isFinite(tolerance) || tolerance < 0)
    throw new RangeError("Invalid boundary tolerance");
  if (points.length < 3) return points.slice();
  const vertices: Vertex[] = [];
  const extent = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [index, point] of points.entries()) {
    vertices.push({
      point,
      source: index,
      anchor: true,
      previous: index - 1,
      next: index === points.length - 1 ? -1 : index + 1,
      error: 0,
    });
    extent.minX = Math.min(extent.minX, point.x);
    extent.minY = Math.min(extent.minY, point.y);
    extent.maxX = Math.max(extent.maxX, point.x);
    extent.maxY = Math.max(extent.maxY, point.y);
    if ((index + 1) % PRESSURE_PREPARATION_CHECK_INTERVAL === 0) yield;
  }
  let index = 0;
  let inspected = 0;
  while (vertices[index]!.next >= 0) {
    const first = vertices[index]!;
    const middle = vertices[first.next]!;
    if (middle.next < 0) break;
    const changed =
      (yield* removeConcave(vertices, index, tolerance, points, addedTriangle)) ||
      replaceConvexPair(vertices, index, tolerance, extent, addedTriangle);
    index = changed ? Math.max(0, first.previous) : first.next;
    if (++inspected % PRESSURE_PREPARATION_CHECK_INTERVAL === 0) yield;
    // Every successful rewrite removes a vertex; backtracking is at most one link.
  }
  const result: PointV1[] = [];
  for (let current = 0; current >= 0; current = vertices[current]!.next) {
    result.push(vertices[current]!.point);
    if (result.length % PRESSURE_PREPARATION_CHECK_INTERVAL === 0) yield;
  }
  return result;
}

function* removeConcave(
  vertices: Vertex[],
  index: number,
  tolerance: number,
  source: readonly PointV1[],
  addedTriangle?: PressureAdditionRecorder,
): Generator<void, boolean> {
  const first = vertices[index]!;
  const middle = vertices[first.next]!;
  const last = vertices[middle.next]!;
  if (
    cross(first.point, middle.point, last.point) <
    -orientationError(first.point, middle.point, last.point)
  )
    return false;
  let error =
    Math.max(first.error, middle.error) +
    pointSegmentDistance(middle.point, first.point, last.point);
  if (error > tolerance && first.anchor && last.anchor) {
    error = yield* chordError(source, first.source, last.source, tolerance);
  }
  if (error > tolerance) return false;
  recordPressureAddition(addedTriangle, first.point, middle.point, last.point);
  first.error = error;
  last.previous = index;
  first.next = middle.next;
  return true;
}

function replaceConvexPair(
  vertices: Vertex[],
  index: number,
  tolerance: number,
  extent: Extent,
  addedTriangle?: PressureAdditionRecorder,
): boolean {
  const first = vertices[index]!;
  const left = vertices[first.next]!;
  const right = vertices[left.next]!;
  if (right.next < 0) return false;
  const last = vertices[right.next]!;
  const intersection = outwardIntersection(first.point, left.point, right.point, last.point);
  if (intersection === undefined || !inside(intersection, extent)) return false;
  const error =
    Math.max(first.error, left.error, right.error) +
    pointSegmentDistance(intersection, left.point, right.point);
  if (error > tolerance) return false;
  recordPressureAddition(addedTriangle, left.point, intersection, right.point);
  first.error = error;
  left.point = intersection;
  left.anchor = false;
  left.next = right.next;
  left.error = error;
  last.previous = first.next;
  return true;
}

/** A continuous chain inside a segment's tolerance capsule also covers its complete projection. */
function* chordError(
  points: readonly PointV1[],
  first: number,
  last: number,
  tolerance: number,
): Generator<void, number> {
  let maximum = 0;
  for (let index = first + 1; index < last; index += 1) {
    maximum = Math.max(
      maximum,
      pointSegmentDistance(points[index]!, points[first]!, points[last]!),
    );
    if ((index - first) % PRESSURE_PREPARATION_CHECK_INTERVAL === 0) yield;
    if (maximum > tolerance) break;
  }
  return maximum;
}

function outwardIntersection(
  first: PointV1,
  left: PointV1,
  right: PointV1,
  last: PointV1,
): PointV1 | undefined {
  const ax = left.x - first.x;
  const ay = left.y - first.y;
  const bx = last.x - right.x;
  const by = last.y - right.y;
  const determinant = ax * by - ay * bx;
  if (determinant === 0) return undefined;
  const dx = right.x - first.x;
  const dy = right.y - first.y;
  const forward = (dx * by - dy * bx) / determinant;
  const backward = (dx * ay - dy * ax) / determinant;
  if (forward < 1 || backward > 0) return undefined;
  const intersection = { x: first.x + forward * ax, y: first.y + forward * ay };
  return cross(left, intersection, right) < 0 ? intersection : undefined;
}

function cross(first: PointV1, middle: PointV1, last: PointV1): number {
  return (middle.x - first.x) * (last.y - first.y) - (middle.y - first.y) * (last.x - first.x);
}

/** Allow only floating-point uncertainty when generated tangent contacts are collinear. */
function orientationError(first: PointV1, middle: PointV1, last: PointV1): number {
  const magnitude = Math.max(
    1,
    Math.abs(first.x),
    Math.abs(first.y),
    Math.abs(middle.x),
    Math.abs(middle.y),
    Math.abs(last.x),
    Math.abs(last.y),
  );
  const extent =
    Math.abs(middle.x - first.x) +
    Math.abs(middle.y - first.y) +
    Math.abs(last.x - first.x) +
    Math.abs(last.y - first.y);
  return 32 * Number.EPSILON * magnitude * extent;
}

function inside(point: PointV1, extent: Extent): boolean {
  return (
    point.x >= extent.minX &&
    point.x <= extent.maxX &&
    point.y >= extent.minY &&
    point.y <= extent.maxY
  );
}
