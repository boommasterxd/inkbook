import { shapeVertices } from "../geometry/creation";
import {
  boundsFromPoints,
  pointDistance,
  rotatePointClockwise,
  rotatePointsClockwise,
  type Bounds,
} from "../geometry/primitives";
import type { PointV1 } from "../schema/types";
import type { RecognizedClosedShape } from "./recognition-types";
import { refinePolygonBoundsSteps } from "./closed-contour-fit";

export interface ClosedFit {
  shape: RecognizedClosedShape;
  score: number;
  maxError: number;
  perimeter: number;
}

interface PreparedClosedPath {
  readonly local: readonly PointV1[];
  readonly bounds: Bounds;
  readonly localPivot: PointV1;
  readonly pivot: PointV1;
  readonly width: number;
  readonly height: number;
  readonly diagonal: number;
  readonly rotation: number;
  readonly gap: number;
}

/** All shape kinds at one angle share the same local points and bounding geometry. */
export function prepareClosedPath(
  points: readonly PointV1[],
  rotation: number,
): PreparedClosedPath | null {
  const origin = { x: 0, y: 0 };
  const local = rotatePointsClockwise(points, origin, -rotation);
  const bounds = boundsFromPoints(local);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const diagonal = Math.hypot(width, height);
  if (Math.min(width, height) < diagonal * 0.08) return null;
  const localPivot = { x: bounds.minX + width / 2, y: bounds.minY + height / 2 };
  const pivot = rotatePointClockwise(localPivot, origin, rotation);
  const gap = pointDistance(points[0]!, points[points.length - 1]!);
  return { local, bounds, localPivot, pivot, width, height, diagonal, rotation, gap };
}

export function fitClosedShape(
  path: PreparedClosedPath,
  kind: RecognizedClosedShape["kind"],
  closingGapLimit = Infinity,
): ClosedFit | null {
  if (!supportsClosingSeam(path, kind, closingGapLimit)) return null;
  if (kind === "rectangle") path = fitRectangleSides(path);
  const { local, bounds, localPivot, pivot, width, height, diagonal, rotation } = path;
  const shape = {
    kind,
    x: pivot.x - width / 2,
    y: pivot.y - height / 2,
    width,
    height,
    pivot,
    rotation,
  };
  const localShape = { ...shape, x: bounds.minX, y: bounds.minY };
  const vertices = kind === "ellipse" ? [] : shapeVertices(localShape);
  const metric =
    kind === "ellipse"
      ? ellipseMetric(local, localPivot, width / 2, height / 2)
      : polygonMetric(local, vertices);
  if (metric.backtracking > metric.perimeter * 0.09) return null;
  if (Math.abs(metric.travel / metric.perimeter - 1) > 0.22) return null;
  return {
    shape,
    score: metric.rms / diagonal,
    maxError: metric.max / diagonal,
    perimeter: metric.perimeter,
  };
}

export function* refineClosedShapeSteps(
  path: PreparedClosedPath,
  kind: RecognizedClosedShape["kind"],
  closingGapLimit: number,
): Generator<void, ClosedFit | null> {
  const bounds = yield* refinePolygonBoundsSteps(path.local, path.bounds, kind);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const localPivot = { x: bounds.minX + width / 2, y: bounds.minY + height / 2 };
  const pivot = rotatePointClockwise(localPivot, { x: 0, y: 0 }, path.rotation);
  return fitClosedShape(
    { ...path, bounds, width, height, localPivot, pivot },
    kind,
    closingGapLimit,
  );
}

/** Fit the traced side interiors instead of letting a single outward wobble set every edge. */
function fitRectangleSides(path: PreparedClosedPath): PreparedClosedPath {
  const sides = Array.from({ length: 4 }, () => ({ sum: 0, count: 0 }));
  for (const point of path.local) {
    const side = nearestSide(point, path.bounds);
    const horizontal = side >= 2;
    const along = horizontal
      ? (point.x - path.bounds.minX) / path.width
      : (point.y - path.bounds.minY) / path.height;
    if (along < 0.2 || along > 0.8) continue;
    sides[side]!.sum += horizontal ? point.y : point.x;
    sides[side]!.count += 1;
  }
  if (sides.some((side) => side.count < 3)) return path;
  const [minX, maxX, minY, maxY] = sides.map((side) => side.sum / side.count);
  const bounds = { minX: minX!, maxX: maxX!, minY: minY!, maxY: maxY! };
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (width < path.width * 0.8 || height < path.height * 0.8) return path;
  if (
    Math.abs(bounds.minX - path.bounds.minX) +
      Math.abs(bounds.maxX - path.bounds.maxX) +
      Math.abs(bounds.minY - path.bounds.minY) +
      Math.abs(bounds.maxY - path.bounds.maxY) <
    1e-7
  )
    return path;
  const localPivot = { x: bounds.minX + width / 2, y: bounds.minY + height / 2 };
  const pivot = rotatePointClockwise(localPivot, { x: 0, y: 0 }, path.rotation);
  return { ...path, bounds, width, height, localPivot, pivot };
}

/** A gap within one rectangle side may omit at most half of its shortest side. */
function supportsClosingSeam(
  path: PreparedClosedPath,
  kind: RecognizedClosedShape["kind"],
  closingGapLimit: number,
): boolean {
  if (path.gap <= closingGapLimit) return true;
  if (kind !== "rectangle" || path.gap > Math.min(path.width, path.height) / 2) return false;
  return (
    nearestSide(path.local[0]!, path.bounds) ===
    nearestSide(path.local[path.local.length - 1]!, path.bounds)
  );
}

function nearestSide(point: PointV1, bounds: Bounds): number {
  const distances = [
    Math.abs(point.x - bounds.minX),
    Math.abs(point.x - bounds.maxX),
    Math.abs(point.y - bounds.minY),
    Math.abs(point.y - bounds.maxY),
  ];
  return distances.indexOf(Math.min(...distances));
}

interface BoundaryMetric {
  rms: number;
  max: number;
  perimeter: number;
  backtracking: number;
  travel: number;
}

function polygonMetric(points: readonly PointV1[], vertices: readonly PointV1[]): BoundaryMetric {
  const edges = vertices.map((start, index) => {
    const end = vertices[(index + 1) % vertices.length]!;
    const length = pointDistance(start, end);
    return { start, dx: end.x - start.x, dy: end.y - start.y, length, squared: length ** 2 };
  });
  const perimeter = edges.reduce((sum, edge) => sum + edge.length, 0);
  let square = 0;
  let max = 0;
  const positions: number[] = [];
  for (const point of points) {
    let nearestSquared = Infinity;
    let position = 0;
    let offset = 0;
    for (const edge of edges) {
      const x = point.x - edge.start.x;
      const y = point.y - edge.start.y;
      const t = Math.max(0, Math.min(1, (x * edge.dx + y * edge.dy) / edge.squared));
      const dx = x - t * edge.dx;
      const dy = y - t * edge.dy;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < nearestSquared) {
        nearestSquared = distanceSquared;
        position = offset + t * edge.length;
      }
      offset += edge.length;
    }
    positions.push(position);
    square += nearestSquared;
    max = Math.max(max, nearestSquared);
  }
  return {
    rms: Math.sqrt(square / points.length),
    max: Math.sqrt(max),
    perimeter,
    ...contourTraversal(positions, perimeter),
  };
}

function ellipseMetric(
  points: readonly PointV1[],
  center: PointV1,
  rx: number,
  ry: number,
): BoundaryMetric {
  let square = 0;
  let max = 0;
  const positions: number[] = [];
  for (const point of points) {
    const nx = (point.x - center.x) / rx;
    const ny = (point.y - center.y) / ry;
    const radius = Math.hypot(nx, ny);
    const angle = Math.atan2(ny, nx);
    const distance = Math.abs(radius - 1) * Math.hypot(rx * Math.cos(angle), ry * Math.sin(angle));
    square += distance ** 2;
    max = Math.max(max, distance);
    positions.push(angle);
  }
  const h = ((rx - ry) / (rx + ry)) ** 2;
  const perimeter = Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  const traversal = contourTraversal(positions, 2 * Math.PI);
  return {
    rms: Math.sqrt(square / points.length),
    max,
    perimeter,
    backtracking: (traversal.backtracking / (2 * Math.PI)) * perimeter,
    travel: (traversal.travel / (2 * Math.PI)) * perimeter,
  };
}

function contourTraversal(positions: readonly number[], perimeter: number) {
  let positive = 0;
  let negative = 0;
  for (let index = 1; index < positions.length; index += 1) {
    let delta = positions[index]! - positions[index - 1]!;
    if (delta > perimeter / 2) delta -= perimeter;
    if (delta < -perimeter / 2) delta += perimeter;
    if (delta >= 0) positive += delta;
    else negative -= delta;
  }
  const closing = Math.abs(positions[0]! - positions[positions.length - 1]!);
  return {
    backtracking: Math.min(positive, negative),
    travel: positive + negative + Math.min(closing, perimeter - closing),
  };
}
