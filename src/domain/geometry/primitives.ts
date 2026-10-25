import type { PointV1 } from "../schema/types";
import {
  canonicalizeGeometryNumber,
  canonicalizeRotation,
  canonicalizeUnitIntervalNumber,
} from "../schema/canonical";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface UnitVector extends PointV1 {
  length: number;
}

const GEOMETRY_DECIMALS = 3;
export const PAGE_WIDTH = 2048.6;

export function roundCanonical(value: number, decimals = GEOMETRY_DECIMALS): number {
  if (decimals === GEOMETRY_DECIMALS) return canonicalizeGeometryNumber(value);
  if (decimals === 4) return canonicalizeUnitIntervalNumber(value);
  throw new RangeError("Inkbook supports canonical precision of three or four decimals.");
}

export function canonicalPoint(point: PointV1): PointV1 {
  return {
    x: roundCanonical(point.x),
    y: roundCanonical(point.y),
  };
}

export function normalizeRotation(rotation: number): number {
  return canonicalizeRotation(rotation);
}

export function addPoints(left: PointV1, right: PointV1): PointV1 {
  return { x: left.x + right.x, y: left.y + right.y };
}

export function subtractPoints(left: PointV1, right: PointV1): PointV1 {
  return { x: left.x - right.x, y: left.y - right.y };
}

export function scalePoint(point: PointV1, factor: number): PointV1 {
  return { x: point.x * factor, y: point.y * factor };
}

export function midpoint(start: PointV1, end: PointV1): PointV1 {
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

export function linearPivot(start: PointV1, end: PointV1, bend: PointV1 | null): PointV1 {
  const bounds = boundsFromPoints(bend === null ? [start, end] : [start, bend, end]);
  return canonicalPoint({
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  });
}

export function assertFinitePoint(
  point: PointV1,
  message = "Point coordinates must be finite.",
): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError(message);
  }
}

export function pointDistance(start: PointV1, end: PointV1): number {
  return Math.hypot(end.x - start.x, end.y - start.y);
}

function pointDistanceSquared(start: PointV1, end: PointV1): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  return deltaX * deltaX + deltaY * deltaY;
}

export function pointSegmentDistance(point: PointV1, start: PointV1, end: PointV1): number {
  return Math.sqrt(pointSegmentDistanceSquared(point, start, end));
}

function pointSegmentDistanceSquared(point: PointV1, start: PointV1, end: PointV1): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const projection =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared,
          ),
        );
  return pointDistanceSquared(point, {
    x: start.x + projection * deltaX,
    y: start.y + projection * deltaY,
  });
}

export function segmentDistanceSquared(
  leftStart: PointV1,
  leftEnd: PointV1,
  rightStart: PointV1,
  rightEnd: PointV1,
  intersectionTolerance = 0,
): number {
  if (segmentsIntersect(leftStart, leftEnd, rightStart, rightEnd, intersectionTolerance)) return 0;
  return Math.min(
    pointSegmentDistanceSquared(leftStart, rightStart, rightEnd),
    pointSegmentDistanceSquared(leftEnd, rightStart, rightEnd),
    pointSegmentDistanceSquared(rightStart, leftStart, leftEnd),
    pointSegmentDistanceSquared(rightEnd, leftStart, leftEnd),
  );
}

export function pointInPolygon(point: PointV1, vertices: readonly PointV1[]): boolean {
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index++) {
    const left = vertices[index]!;
    const right = vertices[previous]!;
    if (
      left.y > point.y !== right.y > point.y &&
      point.x < ((right.x - left.x) * (point.y - left.y)) / (right.y - left.y) + left.x
    )
      inside = !inside;
  }
  return inside;
}

export function normalizedVector(vector: PointV1): UnitVector | null {
  const length = Math.hypot(vector.x, vector.y);
  if (length === 0 || !Number.isFinite(length)) {
    return null;
  }

  return { x: vector.x / length, y: vector.y / length, length };
}

export function rotateVectorClockwise(vector: PointV1, degrees: number): PointV1 {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: vector.x * cosine - vector.y * sine,
    y: vector.x * sine + vector.y * cosine,
  };
}

export function rotatePointClockwise(point: PointV1, pivot: PointV1, degrees: number): PointV1 {
  const rotated = rotateVectorClockwise(subtractPoints(point, pivot), degrees);
  return addPoints(pivot, rotated);
}

export function boundsContainPoint(bounds: Bounds, point: PointV1): boolean {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  );
}

export function boundsFromPoints(points: readonly PointV1[]): Bounds {
  const first = points[0];
  if (first === undefined) {
    throw new RangeError("Bounds require at least one point.");
  }

  let minX = first.x;
  let minY = first.y;
  let maxX = first.x;
  let maxY = first.y;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return { minX, minY, maxX, maxY };
}

export function expandBounds(bounds: Bounds, amount: number): Bounds {
  return {
    minX: bounds.minX - amount,
    minY: bounds.minY - amount,
    maxX: bounds.maxX + amount,
    maxY: bounds.maxY + amount,
  };
}

export function unionBounds(left: Bounds, right: Bounds): Bounds {
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY),
  };
}

export function quadraticPoint(
  start: PointV1,
  control: PointV1,
  end: PointV1,
  time: number,
): PointV1 {
  const inverse = 1 - time;
  return {
    x: inverse * inverse * start.x + 2 * inverse * time * control.x + time * time * end.x,
    y: inverse * inverse * start.y + 2 * inverse * time * control.y + time * time * end.y,
  };
}

export function quadraticBounds(start: PointV1, control: PointV1, end: PointV1): Bounds {
  const points: PointV1[] = [start, end];
  addQuadraticExtremum(points, start, control, end, "x");
  addQuadraticExtremum(points, start, control, end, "y");
  return boundsFromPoints(points);
}

function addQuadraticExtremum(
  points: PointV1[],
  start: PointV1,
  control: PointV1,
  end: PointV1,
  axis: "x" | "y",
): void {
  const denominator = start[axis] - 2 * control[axis] + end[axis];
  if (denominator === 0) return;
  const time = (start[axis] - control[axis]) / denominator;
  if (time > 0 && time < 1) points.push(quadraticPoint(start, control, end, time));
}

export function segmentsIntersect(
  leftStart: PointV1,
  leftEnd: PointV1,
  rightStart: PointV1,
  rightEnd: PointV1,
  tolerance = 0,
): boolean {
  const first = crossProduct(leftStart, leftEnd, rightStart);
  const second = crossProduct(leftStart, leftEnd, rightEnd);
  const third = crossProduct(rightStart, rightEnd, leftStart);
  const fourth = crossProduct(rightStart, rightEnd, leftEnd);
  if (Math.abs(first) <= tolerance && pointOnSegment(rightStart, leftStart, leftEnd, tolerance)) {
    return true;
  }
  if (Math.abs(second) <= tolerance && pointOnSegment(rightEnd, leftStart, leftEnd, tolerance)) {
    return true;
  }
  if (Math.abs(third) <= tolerance && pointOnSegment(leftStart, rightStart, rightEnd, tolerance)) {
    return true;
  }
  if (Math.abs(fourth) <= tolerance && pointOnSegment(leftEnd, rightStart, rightEnd, tolerance)) {
    return true;
  }
  return first * second < 0 && third * fourth < 0;
}

function pointOnSegment(point: PointV1, start: PointV1, end: PointV1, tolerance: number): boolean {
  return (
    point.x >= Math.min(start.x, end.x) - tolerance &&
    point.x <= Math.max(start.x, end.x) + tolerance &&
    point.y >= Math.min(start.y, end.y) - tolerance &&
    point.y <= Math.max(start.y, end.y) + tolerance
  );
}

function crossProduct(start: PointV1, end: PointV1, point: PointV1): number {
  return (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
}
