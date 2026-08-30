import type { Bounds } from "../../domain/geometry/public";
import type { PointV1 } from "../../domain/schema/public";

export interface AreaPolygon {
  readonly bounds: Bounds;
  readonly points: readonly PointV1[];
}

export type VisibleSelectionPrimitive =
  | {
      readonly kind: "capsule";
      readonly radius: number;
      readonly start: PointV1;
      readonly end: PointV1;
    }
  | { readonly kind: "polygon"; readonly points: readonly PointV1[] };

const EPSILON = 1e-9;

export function primitiveTouchesArea(
  area: AreaPolygon,
  primitive: VisibleSelectionPrimitive,
): boolean {
  return primitive.kind === "capsule"
    ? capsuleTouchesPolygon(primitive, area.points)
    : polygonsTouch(primitive.points, area.points);
}

export function primitiveEnclosedByArea(
  area: AreaPolygon,
  primitive: VisibleSelectionPrimitive,
): boolean {
  return primitive.kind === "capsule"
    ? capsuleEnclosedByPolygon(primitive, area.points)
    : polygonEnclosedByPolygon(primitive.points, area.points);
}

function capsuleTouchesPolygon(
  capsule: Extract<VisibleSelectionPrimitive, { kind: "capsule" }>,
  polygon: readonly PointV1[],
): boolean {
  if (pointInPolygonInclusive(capsule.start, polygon)) return true;
  return somePolygonEdge(polygon, (edgeStart, edgeEnd) =>
    withinCapsuleDistance(capsule, edgeStart, edgeEnd),
  );
}

function capsuleEnclosedByPolygon(
  capsule: Extract<VisibleSelectionPrimitive, { kind: "capsule" }>,
  polygon: readonly PointV1[],
): boolean {
  if (!segmentInsidePolygon(capsule.start, capsule.end, polygon)) return false;
  if (capsule.radius === 0) return true;
  const requiredDistance = squared(capsule.radius);
  return !somePolygonEdge(
    polygon,
    (edgeStart, edgeEnd) =>
      segmentDistanceSquared(capsule.start, capsule.end, edgeStart, edgeEnd) + EPSILON <
      requiredDistance,
  );
}

function withinCapsuleDistance(
  capsule: Extract<VisibleSelectionPrimitive, { kind: "capsule" }>,
  edgeStart: PointV1,
  edgeEnd: PointV1,
): boolean {
  return (
    segmentDistanceSquared(capsule.start, capsule.end, edgeStart, edgeEnd) <=
    squared(capsule.radius)
  );
}

function somePolygonEdge(
  polygon: readonly PointV1[],
  predicate: (start: PointV1, end: PointV1) => boolean,
): boolean {
  for (let index = 0; index < polygon.length; index += 1) {
    if (predicate(polygon[index]!, polygon[(index + 1) % polygon.length]!)) return true;
  }
  return false;
}

function polygonsTouch(left: readonly PointV1[], right: readonly PointV1[]): boolean {
  if (left.some((point) => pointInPolygonInclusive(point, right))) return true;
  if (right.some((point) => pointInPolygonInclusive(point, left))) return true;
  return polygonEdgesTouch(left, right);
}

function polygonEnclosedByPolygon(inner: readonly PointV1[], outer: readonly PointV1[]): boolean {
  if (!inner.every((point) => pointInPolygonInclusive(point, outer))) return false;
  for (let index = 0; index < inner.length; index += 1) {
    if (!segmentInsidePolygon(inner[index]!, inner[(index + 1) % inner.length]!, outer)) {
      return false;
    }
  }
  return true;
}

function polygonEdgesTouch(left: readonly PointV1[], right: readonly PointV1[]): boolean {
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const leftStart = left[leftIndex]!;
    const leftEnd = left[(leftIndex + 1) % left.length]!;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if (
        segmentsIntersect(
          leftStart,
          leftEnd,
          right[rightIndex]!,
          right[(rightIndex + 1) % right.length]!,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function segmentInsidePolygon(start: PointV1, end: PointV1, polygon: readonly PointV1[]): boolean {
  if (!pointInPolygonInclusive(start, polygon) || !pointInPolygonInclusive(end, polygon)) {
    return false;
  }
  const times = [0, 1];
  for (let index = 0; index < polygon.length; index += 1) {
    const time = segmentIntersectionTime(
      start,
      end,
      polygon[index]!,
      polygon[(index + 1) % polygon.length]!,
    );
    if (time !== null && time > EPSILON && time < 1 - EPSILON) times.push(time);
  }
  times.sort((left, right) => left - right);
  for (let index = 1; index < times.length; index += 1) {
    const previous = times[index - 1]!;
    const current = times[index]!;
    if (current - previous <= EPSILON) continue;
    if (!pointInPolygonInclusive(pointAlong(start, end, (previous + current) / 2), polygon)) {
      return false;
    }
  }
  return true;
}

function pointInPolygonInclusive(point: PointV1, polygon: readonly PointV1[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const start = polygon[previous]!;
    const end = polygon[index]!;
    if (pointOnSegment(point, start, end)) return true;
    if (
      start.y > point.y !== end.y > point.y &&
      point.x < ((end.x - start.x) * (point.y - start.y)) / (end.y - start.y) + start.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentsIntersect(
  leftStart: PointV1,
  leftEnd: PointV1,
  rightStart: PointV1,
  rightEnd: PointV1,
): boolean {
  if (pointOnSegment(leftStart, rightStart, rightEnd)) return true;
  if (pointOnSegment(leftEnd, rightStart, rightEnd)) return true;
  if (pointOnSegment(rightStart, leftStart, leftEnd)) return true;
  if (pointOnSegment(rightEnd, leftStart, leftEnd)) return true;
  const first = cross(leftStart, leftEnd, rightStart);
  const second = cross(leftStart, leftEnd, rightEnd);
  const third = cross(rightStart, rightEnd, leftStart);
  const fourth = cross(rightStart, rightEnd, leftEnd);
  return first * second < 0 && third * fourth < 0;
}

function segmentIntersectionTime(
  start: PointV1,
  end: PointV1,
  edgeStart: PointV1,
  edgeEnd: PointV1,
): number | null {
  const direction = { x: end.x - start.x, y: end.y - start.y };
  const edgeDirection = { x: edgeEnd.x - edgeStart.x, y: edgeEnd.y - edgeStart.y };
  const denominator = direction.x * edgeDirection.y - direction.y * edgeDirection.x;
  if (Math.abs(denominator) <= EPSILON) return null;
  const offset = { x: edgeStart.x - start.x, y: edgeStart.y - start.y };
  const time = (offset.x * edgeDirection.y - offset.y * edgeDirection.x) / denominator;
  const edgeTime = (offset.x * direction.y - offset.y * direction.x) / denominator;
  return time >= -EPSILON && time <= 1 + EPSILON && edgeTime >= -EPSILON && edgeTime <= 1 + EPSILON
    ? Math.max(0, Math.min(1, time))
    : null;
}

function segmentDistanceSquared(
  leftStart: PointV1,
  leftEnd: PointV1,
  rightStart: PointV1,
  rightEnd: PointV1,
): number {
  if (segmentsIntersect(leftStart, leftEnd, rightStart, rightEnd)) return 0;
  return Math.min(
    pointSegmentDistanceSquared(leftStart, rightStart, rightEnd),
    pointSegmentDistanceSquared(leftEnd, rightStart, rightEnd),
    pointSegmentDistanceSquared(rightStart, leftStart, leftEnd),
    pointSegmentDistanceSquared(rightEnd, leftStart, leftEnd),
  );
}

function pointSegmentDistanceSquared(point: PointV1, start: PointV1, end: PointV1): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const ratio =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
        );
  return squaredDistance(point, { x: start.x + ratio * dx, y: start.y + ratio * dy });
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

function squaredDistance(left: PointV1, right: PointV1): number {
  return squared(left.x - right.x) + squared(left.y - right.y);
}

function squared(value: number): number {
  return value * value;
}
