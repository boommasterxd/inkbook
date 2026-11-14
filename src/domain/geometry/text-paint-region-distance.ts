import { roundedBackgroundBoundary, type TextBackgroundBoundary } from "./rounded-background-path";
import type { TextPaintRegion } from "./text-paint-regions";
import type { PointV1 } from "../schema/public";
import { segmentDistanceSquared } from "./primitives";

interface NumericSegment {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
}

const EPSILON = 1e-9;

/** The stored paint rectangle may be clipped by the field's exact rounded background. */
export function textRegionTouchesSweep(
  region: TextPaintRegion,
  sweep: NumericSegment,
  radius: number,
): boolean {
  if (contains(region, sweep.startX, sweep.startY) || contains(region, sweep.endX, sweep.endY))
    return true;
  const clip = region.roundedClip;
  const boundary = roundedBackgroundBoundary(
    clip ? { x: 0, y: 0, width: clip.width, height: clip.height } : region,
    region,
    clip?.radius ?? 0,
  );
  for (const edge of boundary) {
    const distance =
      edge.radius === undefined
        ? segmentDistanceSquared(
            { x: sweep.startX, y: sweep.startY },
            { x: sweep.endX, y: sweep.endY },
            edge.start,
            edge.end,
          )
        : arcDistanceSquared(sweep, edge);
    if (distance <= radius * radius + EPSILON) return true;
  }
  return false;
}

function contains(region: TextPaintRegion, x: number, y: number): boolean {
  if (x < region.x || y < region.y || x > region.x + region.width || y > region.y + region.height)
    return false;
  const clip = region.roundedClip;
  if (!clip) return true;
  const dx = Math.max(clip.radius - x, 0, x - clip.width + clip.radius);
  const dy = Math.max(clip.radius - y, 0, y - clip.height + clip.radius);
  return dx * dx + dy * dy <= clip.radius * clip.radius + EPSILON;
}

function arcDistanceSquared(sweep: NumericSegment, edge: TextBackgroundBoundary): number {
  const radius = edge.radius!;
  const dx = edge.end.x - edge.start.x;
  const dy = edge.end.y - edge.start.y;
  const chordSquared = dx * dx + dy * dy;
  if (chordSquared === 0) return pointSegmentDistanceSquared(edge.start.x, edge.start.y, sweep);
  const offset = Math.sqrt(Math.max(0, (radius * radius) / chordSquared - 0.25));
  const center = {
    x: (edge.start.x + edge.end.x) / 2 - dy * offset,
    y: (edge.start.y + edge.end.y) / 2 + dx * offset,
  };
  let distance = Math.min(
    pointArcDistanceSquared({ x: sweep.startX, y: sweep.startY }, edge, center),
    pointArcDistanceSquared({ x: sweep.endX, y: sweep.endY }, edge, center),
    pointSegmentDistanceSquared(edge.start.x, edge.start.y, sweep),
    pointSegmentDistanceSquared(edge.end.x, edge.end.y, sweep),
  );
  const sx = sweep.endX - sweep.startX;
  const sy = sweep.endY - sweep.startY;
  const lengthSquared = sx * sx + sy * sy;
  if (lengthSquared === 0) return distance;
  const projection =
    ((center.x - sweep.startX) * sx + (center.y - sweep.startY) * sy) / lengthSquared;
  const nearest = { x: sweep.startX + projection * sx, y: sweep.startY + projection * sy };
  const centerDistanceSquared = (nearest.x - center.x) ** 2 + (nearest.y - center.y) ** 2;
  const root = Math.sqrt(Math.max(0, (radius * radius - centerDistanceSquared) / lengthSquared));
  if (centerDistanceSquared <= radius * radius + EPSILON) {
    for (const t of [projection - root, projection + root]) {
      if (
        t >= 0 &&
        t <= 1 &&
        onArc({ x: sweep.startX + t * sx, y: sweep.startY + t * sy }, edge, center)
      )
        return 0;
    }
  }
  if (projection < 0 || projection > 1) return distance;
  const length = Math.sqrt(lengthSquared);
  for (const sign of [-1, 1]) {
    const candidate = {
      x: center.x - (sign * sy * radius) / length,
      y: center.y + (sign * sx * radius) / length,
    };
    if (onArc(candidate, edge, center))
      distance = Math.min(distance, pointSegmentDistanceSquared(candidate.x, candidate.y, sweep));
  }
  return distance;
}

function pointArcDistanceSquared(
  point: PointV1,
  edge: TextBackgroundBoundary,
  center: PointV1,
): number {
  if (onArc(point, edge, center))
    return (Math.hypot(point.x - center.x, point.y - center.y) - edge.radius!) ** 2;
  return Math.min(
    (point.x - edge.start.x) ** 2 + (point.y - edge.start.y) ** 2,
    (point.x - edge.end.x) ** 2 + (point.y - edge.end.y) ** 2,
  );
}

function onArc(point: PointV1, edge: TextBackgroundBoundary, center: PointV1): boolean {
  const x = point.x - center.x;
  const y = point.y - center.y;
  return (
    (edge.start.x - center.x) * y - (edge.start.y - center.y) * x >= -EPSILON &&
    x * (edge.end.y - center.y) - y * (edge.end.x - center.x) >= -EPSILON
  );
}

function pointSegmentDistanceSquared(x: number, y: number, sweep: NumericSegment): number {
  const point = { x, y };
  return segmentDistanceSquared(
    point,
    point,
    { x: sweep.startX, y: sweep.startY },
    { x: sweep.endX, y: sweep.endY },
  );
}
