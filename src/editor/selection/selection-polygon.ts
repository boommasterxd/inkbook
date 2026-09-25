import type { PointV1 } from "../../domain/schema/public";

const EPSILON = 1e-9;

export function* segmentInsidePolygon(
  start: PointV1,
  end: PointV1,
  polygon: readonly PointV1[],
): Generator<void, boolean> {
  if (!pointInPolygonInclusive(start, polygon) || !pointInPolygonInclusive(end, polygon)) {
    return false;
  }
  const times = [0, 1];
  for (let index = 0; index < polygon.length; index += 1) {
    times.push(
      ...lineIntersectionTimes(start, end, polygon[index]!, polygon[(index + 1) % polygon.length]!),
    );
    if (index % 32 === 31) yield;
  }
  times.sort((left, right) => left - right);
  for (let index = 1; index < times.length; index += 1) {
    const previous = times[index - 1]!;
    const current = times[index]!;
    if (current - previous <= EPSILON) continue;
    if (!pointInPolygonInclusive(pointAlong(start, end, (previous + current) / 2), polygon)) {
      return false;
    }
    yield;
  }
  return true;
}

export function pointInPolygonInclusive(
  point: PointV1,
  polygon: readonly PointV1[],
  includeBoundary = true,
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const start = polygon[previous]!;
    const end = polygon[index]!;
    if (includeBoundary && pointOnSegment(point, start, end)) return true;
    if (
      start.y > point.y !== end.y > point.y &&
      point.x < ((end.x - start.x) * (point.y - start.y)) / (end.y - start.y) + start.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function pointOnSegment(point: PointV1, start: PointV1, end: PointV1): boolean {
  if (Math.abs(cross(start, end, point)) > EPSILON) return false;
  return (
    point.x >= Math.min(start.x, end.x) - EPSILON &&
    point.x <= Math.max(start.x, end.x) + EPSILON &&
    point.y >= Math.min(start.y, end.y) - EPSILON &&
    point.y <= Math.max(start.y, end.y) + EPSILON
  );
}

function cross(start: PointV1, end: PointV1, point: PointV1): number {
  return (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
}

function pointAlong(start: PointV1, end: PointV1, time: number): PointV1 {
  return { x: start.x + (end.x - start.x) * time, y: start.y + (end.y - start.y) * time };
}

function lineIntersectionTimes(
  start: PointV1,
  end: PointV1,
  first: PointV1,
  last: PointV1,
): number[] {
  const direction = difference(end, start);
  const edge = difference(last, first);
  const offset = difference(first, start);
  const denominator = vectorCross(direction, edge);
  if (Math.abs(denominator) > EPSILON) {
    const time = vectorCross(offset, edge) / denominator;
    const edgeTime = vectorCross(offset, direction) / denominator;
    return time >= -EPSILON &&
      time <= 1 + EPSILON &&
      edgeTime >= -EPSILON &&
      edgeTime <= 1 + EPSILON
      ? [clamp(time)]
      : [];
  }
  if (Math.abs(vectorCross(direction, offset)) > EPSILON) return [];
  const lengthSquared = direction.x ** 2 + direction.y ** 2;
  if (lengthSquared === 0) return [];
  const projected = (point: PointV1) =>
    ((point.x - start.x) * direction.x + (point.y - start.y) * direction.y) / lengthSquared;
  const low = Math.max(0, Math.min(projected(first), projected(last)));
  const high = Math.min(1, Math.max(projected(first), projected(last)));
  return low <= high + EPSILON ? [clamp(low), clamp(high)] : [];
}

function difference(left: PointV1, right: PointV1): PointV1 {
  return { x: left.x - right.x, y: left.y - right.y };
}

function vectorCross(left: PointV1, right: PointV1): number {
  return left.x * right.y - left.y * right.x;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
