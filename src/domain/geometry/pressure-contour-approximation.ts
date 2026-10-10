import type { PointV1 } from "../schema/types";
import { pressureArcPoint, type PressureBoundaryArc } from "./pressure-joins";
import type { PressureBoundarySegment } from "./pressure-boundary-intersections";
import { iteratePressureBoundarySimplification } from "./pressure-boundary-simplification";
import { iteratePressureContourQuantization } from "./pressure-contour-quantization";
import { PRESSURE_PREPARATION_CHECK_INTERVAL } from "./pressure-union";
import type { PressureAdditions } from "./pressure-additions";

export function pressureContourOutwardError(width: number): number {
  return Math.min(0.5, width / 32);
}

/** Every rewrite adds clockwise triangles; the original union remains filled. */
export function* iteratePressureContourApproximation(
  loop: readonly PressureBoundarySegment[],
  width: number,
  additions: PressureAdditions,
): Generator<void, PressureBoundarySegment[]> {
  if (loop.length === 0) return [];
  const grid = width >= 10 ? 0.1 : width >= 1 ? 0.01 : 0.001;
  const tolerance = (pressureContourOutwardError(width) - Math.SQRT2 * (grid + 0.0005)) / 2;
  if (tolerance <= 0) return [...loop];
  const triangles: (readonly PointV1[])[] = [];
  const triangleCount = { count: 0 };
  const staged = Array.isArray(additions) ? triangles : triangleCount;
  const points = [loop[0]!.start];
  for (const edge of loop) {
    if (edge.kind === "line") points.push(edge.end);
    else yield* appendArc(points, edge, tolerance, staged);
    if (points.length > 4096) return [...loop];
    if (points.length % PRESSURE_PREPARATION_CHECK_INTERVAL === 0) yield;
  }
  const reduced = yield* iteratePressureBoundarySimplification(points, tolerance, additions);
  const rounded = yield* iteratePressureContourQuantization(reduced, grid, staged);
  if (Array.isArray(additions)) additions.push(...triangles);
  else additions.count += triangleCount.count;
  return rounded.slice(1).map((end, index) => ({ kind: "line", start: rounded[index]!, end }));
}

function* appendArc(
  points: PointV1[],
  arc: PressureBoundaryArc,
  tolerance: number,
  additions: PressureAdditions,
): Generator<void> {
  const angle = Math.atan2(arc.start.y - arc.center.y, arc.start.x - arc.center.x);
  const stop = angle + arc.sweep;
  const cuts = [0, 1];
  for (
    let axis = Math.ceil(Math.min(angle, stop) / (Math.PI / 2));
    axis <= Math.floor(Math.max(angle, stop) / (Math.PI / 2));
    axis += 1
  ) {
    const fraction = ((axis * Math.PI) / 2 - angle) / arc.sweep;
    if (fraction > 0 && fraction < 1) cuts.push(fraction);
  }
  cuts.sort((a, b) => a - b);
  const maximum = 2 * Math.acos(arc.radius / (arc.radius + tolerance));
  for (let index = 1; index < cuts.length; index += 1) {
    const first = cuts[index - 1]!;
    const last = cuts[index]!;
    const count = Math.max(1, Math.ceil(Math.abs(arc.sweep * (last - first)) / maximum));
    for (let part = 0; part < count; part += 1) {
      const from = first + ((last - first) * part) / count;
      const to = first + ((last - first) * (part + 1)) / count;
      const middle = angle + (arc.sweep * (from + to)) / 2;
      const radius = arc.radius / Math.cos((arc.sweep * (to - from)) / 2);
      const support = {
        x: clamp(arc.center.x + Math.cos(middle) * radius, arc.center.x, arc.radius),
        y: clamp(arc.center.y + Math.sin(middle) * radius, arc.center.y, arc.radius),
      };
      points.push(support);
      if (Array.isArray(additions))
        additions.push([pressureArcPoint(arc, from), support, pressureArcPoint(arc, to)]);
      else additions.count += 1;
      if (points.length % PRESSURE_PREPARATION_CHECK_INTERVAL === 0) yield;
      if (points.length > 4096) return;
    }
  }
  points.push(arc.end);
}
function clamp(value: number, center: number, radius: number): number {
  return Math.max(center - radius, Math.min(center + radius, value));
}
