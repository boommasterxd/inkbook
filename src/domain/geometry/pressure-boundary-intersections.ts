import type { PointV1 } from "../schema/types";
import { pressureArcPoint } from "./pressure-joins";
import type { PressureBoundaryArc, PressureBoundaryLine } from "./pressure-joins";

export type PressureBoundarySegment = PressureBoundaryLine | PressureBoundaryArc;
export interface PressureBoundaryIntersection {
  readonly first: number;
  readonly second: number;
}

const TURN = 2 * Math.PI;

export function pressureBoundaryPoint(
  boundary: PressureBoundarySegment,
  fraction: number,
): PointV1 {
  if (boundary.kind === "arc") return pressureArcPoint(boundary, fraction);
  return {
    x: boundary.start.x + (boundary.end.x - boundary.start.x) * fraction,
    y: boundary.start.y + (boundary.end.y - boundary.start.y) * fraction,
  };
}

/** Coordinate roundoff, not an approximation tolerance for the rendered contour. */
function roundoff(first: PointV1, second: PointV1, third: PointV1, fourth = first): number {
  const scale = Math.max(
    1,
    Math.abs(first.x),
    Math.abs(first.y),
    Math.abs(second.x),
    Math.abs(second.y),
    Math.abs(third.x),
    Math.abs(third.y),
    Math.abs(fourth.x),
    Math.abs(fourth.y),
  );
  return 32 * Number.EPSILON * scale;
}

function distance(first: PointV1, second: PointV1): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function withinRoundoff(first: PointV1, second: PointV1, epsilon: number): boolean {
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  // A Euclidean distance cannot be smaller than either coordinate difference.
  return Math.abs(dx) <= epsilon && Math.abs(dy) <= epsilon && Math.hypot(dx, dy) <= epsilon;
}

export function pressureBoundaryParameter(
  boundary: PressureBoundarySegment,
  point: PointV1,
): number | undefined {
  const epsilon = roundoff(boundary.start, boundary.end, point);
  if (withinRoundoff(point, boundary.start, epsilon)) return 0;
  if (withinRoundoff(point, boundary.end, epsilon)) return 1;
  if (boundary.kind === "arc") return arcParameter(boundary, point, epsilon);
  const dx = boundary.end.x - boundary.start.x;
  const dy = boundary.end.y - boundary.start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return undefined;
  const fraction =
    ((point.x - boundary.start.x) * dx + (point.y - boundary.start.y) * dy) / lengthSquared;
  if (fraction < 0 || fraction > 1) return undefined;
  return withinRoundoff(pressureBoundaryPoint(boundary, fraction), point, epsilon)
    ? fraction
    : undefined;
}

function arcParameter(
  arc: PressureBoundaryArc,
  point: PointV1,
  epsilon: number,
): number | undefined {
  const axisDistance = Math.max(Math.abs(point.x - arc.center.x), Math.abs(point.y - arc.center.y));
  if (
    arc.sweep === 0 ||
    axisDistance - arc.radius > epsilon ||
    Math.abs(distance(arc.center, point) - arc.radius) > epsilon
  )
    return undefined;
  const initial = Math.atan2(arc.start.y - arc.center.y, arc.start.x - arc.center.x);
  const angle = Math.atan2(point.y - arc.center.y, point.x - arc.center.x);
  const travel = ((((angle - initial) * Math.sign(arc.sweep)) % TURN) + TURN) % TURN;
  const fraction = travel / Math.abs(arc.sweep);
  return fraction <= 1 ? fraction : undefined;
}

/** Includes overlap endpoints; a coincident interval is split at every arc/line endpoint. */
export function intersectPressureBoundaries(
  first: PressureBoundarySegment,
  second: PressureBoundarySegment,
): readonly PressureBoundaryIntersection[] {
  const result: PressureBoundaryIntersection[] = [];
  addEndpoints(first, second, result);
  for (const point of intersectionPoints(first, second)) {
    const a = pressureBoundaryParameter(first, point);
    const b = pressureBoundaryParameter(second, point);
    if (a !== undefined && b !== undefined) addIntersection(result, a, b);
  }
  return result;
}

function addIntersection(
  result: PressureBoundaryIntersection[],
  first: number,
  second: number,
): void {
  if (!result.some((entry) => entry.first === first && entry.second === second))
    result.push({ first, second });
}

function addEndpoints(
  first: PressureBoundarySegment,
  second: PressureBoundarySegment,
  result: PressureBoundaryIntersection[],
): void {
  for (const fraction of [0, 1]) {
    const point = fraction === 0 ? first.start : first.end;
    const parameter = pressureBoundaryParameter(second, point);
    if (parameter !== undefined) addIntersection(result, fraction, parameter);
    const other = fraction === 0 ? second.start : second.end;
    const reverse = pressureBoundaryParameter(first, other);
    if (reverse !== undefined) addIntersection(result, reverse, fraction);
  }
}

function intersectionPoints(
  first: PressureBoundarySegment,
  second: PressureBoundarySegment,
): readonly PointV1[] {
  if (first.kind === "line")
    return second.kind === "line" ? lineLine(first, second) : lineArc(first, second);
  return second.kind === "line" ? lineArc(second, first) : arcArc(first, second);
}

function lineLine(first: PressureBoundaryLine, second: PressureBoundaryLine): readonly PointV1[] {
  const dx = first.end.x - first.start.x;
  const dy = first.end.y - first.start.y;
  const ex = second.end.x - second.start.x;
  const ey = second.end.y - second.start.y;
  const determinant = dx * ey - dy * ex;
  if (determinant === 0) return [];
  const x = second.start.x - first.start.x;
  const y = second.start.y - first.start.y;
  const fraction = (x * ey - y * ex) / determinant;
  return [pressureBoundaryPoint(first, fraction)];
}

function lineArc(line: PressureBoundaryLine, arc: PressureBoundaryArc): readonly PointV1[] {
  const dx = line.end.x - line.start.x;
  const dy = line.end.y - line.start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return [];
  const ux = dx / length;
  const uy = dy / length;
  const cx = arc.center.x - line.start.x;
  const cy = arc.center.y - line.start.y;
  const along = cx * ux + cy * uy;
  const perpendicular = cx * uy - cy * ux;
  const epsilon = roundoff(line.start, line.end, arc.center);
  if (Math.abs(perpendicular) > arc.radius + epsilon) return [];
  const offset = Math.sqrt(
    Math.max(0, (arc.radius - Math.abs(perpendicular)) * (arc.radius + Math.abs(perpendicular))),
  );
  const middle = { x: line.start.x + along * ux, y: line.start.y + along * uy };
  if (offset === 0) return [middle];
  return [
    { x: middle.x - offset * ux, y: middle.y - offset * uy },
    { x: middle.x + offset * ux, y: middle.y + offset * uy },
  ];
}

function arcArc(first: PressureBoundaryArc, second: PressureBoundaryArc): readonly PointV1[] {
  const dx = second.center.x - first.center.x;
  const dy = second.center.y - first.center.y;
  const epsilon = roundoff(first.center, second.center, first.start, second.start);
  const maximumSeparation = first.radius + second.radius + epsilon;
  if (Math.max(Math.abs(dx), Math.abs(dy)) > maximumSeparation) return [];
  const separation = Math.hypot(dx, dy);
  if (separation <= epsilon) return [];
  if (separation > maximumSeparation) return [];
  if (separation < Math.abs(first.radius - second.radius) - epsilon) return [];
  const along =
    (separation + ((first.radius - second.radius) * (first.radius + second.radius)) / separation) /
    2;
  const height = Math.sqrt(Math.max(0, (first.radius - along) * (first.radius + along)));
  const middle = {
    x: first.center.x + (along * dx) / separation,
    y: first.center.y + (along * dy) / separation,
  };
  if (height === 0) return [middle];
  return [
    { x: middle.x - (height * dy) / separation, y: middle.y + (height * dx) / separation },
    { x: middle.x + (height * dy) / separation, y: middle.y - (height * dx) / separation },
  ];
}
