export interface NumericSegment {
  endX: number;
  endY: number;
  startX: number;
  startY: number;
}

export function segmentBoundsOverlap(
  first: NumericSegment,
  second: NumericSegment,
  radius: number,
): boolean {
  return (
    Math.min(first.startX, first.endX) - radius <= Math.max(second.startX, second.endX) &&
    Math.max(first.startX, first.endX) + radius >= Math.min(second.startX, second.endX) &&
    Math.min(first.startY, first.endY) - radius <= Math.max(second.startY, second.endY) &&
    Math.max(first.startY, first.endY) + radius >= Math.min(second.startY, second.endY)
  );
}

export function segmentDistanceSquared(first: NumericSegment, second: NumericSegment): number {
  if (segmentsIntersect(first, second)) return 0;
  return Math.min(
    pointSegmentDistanceSquared(first.startX, first.startY, second),
    pointSegmentDistanceSquared(first.endX, first.endY, second),
    pointSegmentDistanceSquared(second.startX, second.startY, first),
    pointSegmentDistanceSquared(second.endX, second.endY, first),
  );
}

export function pointSegmentDistanceSquared(x: number, y: number, segment: NumericSegment): number {
  const dx = segment.endX - segment.startX;
  const dy = segment.endY - segment.startY;
  const squaredLength = dx * dx + dy * dy;
  const ratio =
    squaredLength === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((x - segment.startX) * dx + (y - segment.startY) * dy) / squaredLength),
        );
  const offsetX = x - (segment.startX + ratio * dx);
  const offsetY = y - (segment.startY + ratio * dy);
  return offsetX * offsetX + offsetY * offsetY;
}

function segmentsIntersect(left: NumericSegment, right: NumericSegment): boolean {
  const first = cross(left.startX, left.startY, left.endX, left.endY, right.startX, right.startY);
  const second = cross(left.startX, left.startY, left.endX, left.endY, right.endX, right.endY);
  const third = cross(right.startX, right.startY, right.endX, right.endY, left.startX, left.startY);
  const fourth = cross(right.startX, right.startY, right.endX, right.endY, left.endX, left.endY);
  if (first === 0 && onSegment(left, right.startX, right.startY)) return true;
  if (second === 0 && onSegment(left, right.endX, right.endY)) return true;
  if (third === 0 && onSegment(right, left.startX, left.startY)) return true;
  if (fourth === 0 && onSegment(right, left.endX, left.endY)) return true;
  return first > 0 !== second > 0 && third > 0 !== fourth > 0;
}

function cross(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

function onSegment(segment: NumericSegment, px: number, py: number): boolean {
  return (
    px >= Math.min(segment.startX, segment.endX) &&
    px <= Math.max(segment.startX, segment.endX) &&
    py >= Math.min(segment.startY, segment.endY) &&
    py <= Math.max(segment.startY, segment.endY)
  );
}
