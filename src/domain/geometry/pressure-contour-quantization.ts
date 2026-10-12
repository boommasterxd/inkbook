import type { PointV1 } from "../schema/types";
import { PRESSURE_PREPARATION_CHECK_INTERVAL } from "./pressure-union";
import { recordPressureAddition, type PressureAdditions } from "./pressure-additions";

/** Each checkpoint groups a bounded number of vertex inspections or local removals. */
export function* iteratePressureContourQuantization(
  closed: readonly PointV1[],
  grid: number,
  additions: PressureAdditions,
): Generator<void, PointV1[]> {
  const points = closed.slice(0, -1);
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  let inspected = 0;
  for (const point of points) {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxY = Math.max(bounds.maxY, point.y);
    if (++inspected % PRESSURE_PREPARATION_CHECK_INTERVAL === 0) yield;
  }
  for (let index = 0; index < points.length; index += 1) {
    const before = points[(index + points.length - 1) % points.length]!;
    const current = points[index]!;
    const after = points[(index + 1) % points.length]!;
    const x = Math.floor(current.x / grid) * grid;
    const y = Math.floor(current.y / grid) * grid;
    let best = current;
    let distance = Infinity;
    for (let candidate = 0; candidate < 16; candidate += 1) {
      const next = {
        x: x + ((candidate % 4) - 1) * grid,
        y: y + (Math.floor(candidate / 4) - 1) * grid,
      };
      const displacement = Math.hypot(next.x - current.x, next.y - current.y);
      if (
        displacement > Math.SQRT2 * grid ||
        displacement >= distance ||
        next.x < bounds.minX ||
        next.x > bounds.maxX ||
        next.y < bounds.minY ||
        next.y > bounds.maxY
      )
        continue;
      if (
        cross(before, current, next) < -roundoff(before, current, next) ||
        cross(current, after, next) < -roundoff(current, after, next)
      )
        continue;
      best = next;
      distance = displacement;
    }
    if (best !== current) {
      recordPressureAddition(additions, before, best, current);
      recordPressureAddition(additions, current, best, after);
      points[index] = best;
    }
    if ((index + 1) % PRESSURE_PREPARATION_CHECK_INTERVAL === 0) yield;
  }
  yield* removeCollinear(points);
  return [...points, points[0]!];
}
function* removeCollinear(points: PointV1[]): Generator<void> {
  let changed = true;
  let inspected = 0;
  while (changed && points.length > 3) {
    changed = false;
    for (let index = 0; index < points.length; index += 1) {
      const before = points[(index + points.length - 1) % points.length]!;
      const current = points[index]!;
      const after = points[(index + 1) % points.length]!;
      if (++inspected % PRESSURE_PREPARATION_CHECK_INTERVAL === 0) yield;
      if (
        Math.abs(cross(before, current, after)) > roundoff(before, current, after) ||
        (current.x - before.x) * (after.x - current.x) +
          (current.y - before.y) * (after.y - current.y) <
          0
      )
        continue;
      points.splice(index, 1);
      changed = true;
      break;
    }
  }
}
function cross(first: PointV1, second: PointV1, third: PointV1): number {
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
}

function roundoff(first: PointV1, second: PointV1, third: PointV1): number {
  const x = second.x - first.x;
  const y = second.y - first.y;
  return (
    8 * Number.EPSILON * (Math.abs(x * (third.y - first.y)) + Math.abs(y * (third.x - first.x)))
  );
}
