import type { PointV1 } from "../schema/types";

/** Separate smooth half-circle-like arches from corners, hooks and inflected paths. */
export function hasSmoothArcProfile(points: readonly PointV1[], times: readonly number[]): boolean {
  const support: PointV1[] = [];
  let segment = 1;
  // Ignore only the outer 2.5% of path distance when estimating tangents, not fit residuals.
  for (let index = 0; index <= 16; index += 1) {
    const target = 0.025 + (0.95 * index) / 16;
    while (segment < points.length - 1 && times[segment]! < target) segment += 1;
    const before = times[segment - 1]!;
    const t = (target - before) / (times[segment]! - before);
    const a = points[segment - 1]!;
    const b = points[segment]!;
    support.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  let turn = 0;
  let absoluteTurn = 0;
  for (let index = 1; index < support.length - 1; index += 1) {
    const a = support[index - 1]!;
    const b = support[index]!;
    const c = support[index + 1]!;
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const vx = c.x - b.x;
    const vy = c.y - b.y;
    const angle = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    if (Math.abs(angle) > 0.5) return false;
    turn += angle;
    absoluteTurn += Math.abs(angle);
  }
  return Math.abs(turn) >= 1.2 && Math.abs(turn) <= 3.35 && absoluteTurn - Math.abs(turn) <= 0.4;
}
