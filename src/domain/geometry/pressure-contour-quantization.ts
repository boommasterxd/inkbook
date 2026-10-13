import type { PointV1 } from "../schema/types";
import { PRESSURE_PREPARATION_CHECK_INTERVAL } from "./pressure-union";
import { recordPressureAddition, type PressureAdditions } from "./pressure-additions";
import { iteratePressureCollinearPruning } from "./pressure-collinear-pruning";

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
    const beforeX = before.x;
    const beforeY = before.y;
    const currentX = current.x;
    const currentY = current.y;
    const x = Math.floor(currentX / grid) * grid;
    const y = Math.floor(currentY / grid) * grid;
    const incomingX = currentX - beforeX;
    const incomingY = currentY - beforeY;
    const outgoingX = after.x - currentX;
    const outgoingY = after.y - currentY;
    let best = current;
    let distance = Infinity;
    for (let candidate = 0; candidate < 16; candidate += 1) {
      const next = {
        x: x + ((candidate % 4) - 1) * grid,
        y: y + (Math.floor(candidate / 4) - 1) * grid,
      };
      if (
        next.x < bounds.minX ||
        next.x > bounds.maxX ||
        next.y < bounds.minY ||
        next.y > bounds.maxY
      )
        continue;
      if (
        outsideCross(incomingX * (next.y - beforeY), incomingY * (next.x - beforeX)) ||
        outsideCross(outgoingX * (next.y - currentY), outgoingY * (next.x - currentX))
      )
        continue;
      const displacement = Math.hypot(next.x - currentX, next.y - currentY);
      if (displacement > Math.SQRT2 * grid || displacement >= distance) continue;
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
  yield* iteratePressureCollinearPruning(points);
  return [...points, points[0]!];
}
function outsideCross(first: number, second: number): boolean {
  return first - second < -8 * Number.EPSILON * (Math.abs(first) + Math.abs(second));
}
