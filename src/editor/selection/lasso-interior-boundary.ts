import type { PointV1 } from "../../domain/schema/public";

const EPSILON = 1e-9;

/** An odd-multiplicity lasso edge inside paint borders an excluded even-odd region. */
export function* hasInteriorLassoBoundary(
  inner: readonly PointV1[],
  outer: readonly PointV1[],
  contains: (point: PointV1, polygon: readonly PointV1[]) => boolean,
): Generator<void, boolean> {
  let checked = 0;
  for (const [start, end] of lassoEdges(outer)) {
    checked += 1;
    if (checked % 32 === 0) yield;
    const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    if (!strictlyInside(middle, inner, contains)) continue;
    const times = yield* overlapTimes(start, end, outer);
    for (let step = 1; step < times.length; step += 1) {
      if (times[step]! - times[step - 1]! <= EPSILON) continue;
      const t = (times[step]! + times[step - 1]!) / 2;
      const point = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
      if (!strictlyInside(point, inner, contains)) continue;
      if ((yield* edgeMultiplicity(point, start, end, outer)) % 2 === 1) return true;
    }
  }
  return false;
}

/** Ignores even-multiplicity retraced connectors when testing a painted boundary. */
export function* hasOddLassoBoundary(
  outer: readonly PointV1[],
  near: (start: PointV1, end: PointV1) => boolean,
): Generator<void, boolean> {
  let checked = 0;
  for (const [start, end] of lassoEdges(outer)) {
    checked += 1;
    if (checked % 16 === 0) yield;
    if (!near(start, end)) continue;
    const times = yield* overlapTimes(start, end, outer);
    for (let part = 1; part < times.length; part += 1) {
      const from = times[part - 1]!;
      const to = times[part]!;
      if (to - from <= EPSILON) continue;
      const first = interpolate(start, end, from);
      const last = interpolate(start, end, to);
      if (!near(first, last)) continue;
      if ((yield* edgeMultiplicity(interpolate(first, last, 0.5), start, end, outer)) % 2 === 1)
        return true;
    }
  }
  return false;
}

function* lassoEdges(outer: readonly PointV1[]): Generator<readonly [PointV1, PointV1]> {
  for (let index = 0; index < outer.length; index += 1) {
    const start = outer[index]!;
    const end = outer[(index + 1) % outer.length]!;
    if (start.x !== end.x || start.y !== end.y) yield [start, end];
  }
}

function interpolate(start: PointV1, end: PointV1, t: number): PointV1 {
  return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
}

function* overlapTimes(
  start: PointV1,
  end: PointV1,
  outer: readonly PointV1[],
): Generator<void, number[]> {
  const times = [0, 1];
  for (let vertex = 0; vertex < outer.length; vertex += 1) {
    const point = outer[vertex]!;
    if (onLine(point, start, end)) {
      const time = projectedTime(point, start, end);
      if (time > 0 && time < 1) times.push(time);
    }
    if (vertex % 32 === 31) yield;
  }
  return times.sort((left, right) => left - right);
}

function* edgeMultiplicity(
  point: PointV1,
  start: PointV1,
  end: PointV1,
  outer: readonly PointV1[],
): Generator<void, number> {
  let multiplicity = 0;
  for (let edge = 0; edge < outer.length; edge += 1) {
    const first = outer[edge]!;
    const last = outer[(edge + 1) % outer.length]!;
    const time = projectedTime(point, first, last);
    if (onLine(first, start, end) && onLine(last, start, end) && time > 0 && time < 1)
      multiplicity += 1;
    if (edge % 32 === 31) yield;
  }
  return multiplicity;
}

function strictlyInside(
  point: PointV1,
  polygon: readonly PointV1[],
  contains: (point: PointV1, polygon: readonly PointV1[]) => boolean,
): boolean {
  if (!contains(point, polygon)) return false;
  return !polygon.some((start, index) => {
    const end = polygon[(index + 1) % polygon.length]!;
    const time = projectedTime(point, start, end);
    return onLine(point, start, end) && time >= 0 && time <= 1;
  });
}

function projectedTime(point: PointV1, start: PointV1, end: PointV1): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = dx * dx + dy * dy;
  return length === 0 ? -1 : ((point.x - start.x) * dx + (point.y - start.y) * dy) / length;
}

function onLine(point: PointV1, start: PointV1, end: PointV1): boolean {
  return (
    Math.abs((end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x)) <=
    EPSILON
  );
}
