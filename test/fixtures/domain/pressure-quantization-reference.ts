import type { PointV1 } from "../../../src/domain/schema/types";
import type { PressureTriangle } from "../../../src/domain/geometry/pressure/pressure-additions";

/** Independent grid enumeration with pre-optimization arithmetic and earliest-removal semantics. */
export function referencePressureQuantization(closed: readonly PointV1[], grid: number) {
  const points = closed.slice(0, -1);
  const additions: PressureTriangle[] = [];
  const bounds = points.reduce(
    (extent, point) => ({
      minX: Math.min(extent.minX, point.x),
      maxX: Math.max(extent.maxX, point.x),
      minY: Math.min(extent.minY, point.y),
      maxY: Math.max(extent.maxY, point.y),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );
  for (const [index, current] of points.entries()) {
    const before = index === 0 ? points[points.length - 1]! : points[index - 1]!;
    const after = points[index + 1] ?? points[0]!;
    const origin = [Math.floor(current.x / grid) * grid, Math.floor(current.y / grid) * grid];
    // Row-major enumeration retains exactly the legacy multiplication/addition order.
    const candidates = Array.from({ length: 4 }, (_, row) =>
      Array.from({ length: 4 }, (_, column) => ({
        x: origin[0]! + (column - 1) * grid,
        y: origin[1]! + (row - 1) * grid,
      })),
    ).flat();
    let best = current;
    let distance = Infinity;
    for (const next of candidates) {
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
      additions.push([before, best, current], [current, best, after]);
      points[index] = best;
    }
  }
  referencePressureCollinearPruning(points);
  return { points: [...points, points[0]!], additions };
}

export function referencePressureCollinearPruning(points: PointV1[]): void {
  let changed = true;
  while (changed && points.length > 3) {
    changed = false;
    for (let index = 0; index < points.length; index += 1) {
      const before = points[(index + points.length - 1) % points.length]!;
      const current = points[index]!;
      const after = points[(index + 1) % points.length]!;
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

/** Dense clockwise box with a long final collinear edge, within polyline capacity. */
export function pressureCollinearBox(count: number): PointV1[] {
  return [
    { x: 0, y: 0 },
    { x: 0, y: count },
    { x: count, y: count },
    ...Array.from({ length: count - 3 }, (_, index) => ({
      x: count,
      y: count - index - 1,
    })),
  ];
}
