import type { PointV1 } from "../schema/types";
import { arcTo, lineTo, moveTo } from "./svg-format";

interface PressureCenter extends PointV1 {
  pressure: number;
}

interface SweepSlice {
  readonly firstBoundary: number | null;
  readonly lastBoundary: number | null;
}

export function pressureWidthFactor(pressure: number): number {
  return 0.35 + 0.65 * Math.min(1, Math.max(0, pressure));
}

/** Same-winding convex pieces make self-overlap additive under SVG's nonzero fill. */
export function buildPressureSweep(
  centers: readonly PressureCenter[],
  width: number,
  slice: SweepSlice = { firstBoundary: null, lastBoundary: null },
): string {
  const commands: string[] = [];
  visitPressureSweep(
    centers,
    width,
    (start, end) => {
      commands.push(capsule(start, end, width));
      return false;
    },
    slice,
  );
  return commands.join("");
}

/** Stops when the visitor returns true. Each pair owns one swept disk segment. */
export function visitPressureSweep(
  centers: readonly PressureCenter[],
  width: number,
  visitor: (start: PressureCenter, end: PressureCenter) => boolean,
  slice: SweepSlice = { firstBoundary: null, lastBoundary: null },
): boolean {
  const first = centers[0];
  if (first === undefined) throw new RangeError("A pressure outline requires at least one point.");
  if (centers.length === 1) return visitor(first, first);
  if (centers.length === 2 && slice.firstBoundary === null && slice.lastBoundary === null) {
    return visitor(first, centers[1]!);
  }
  const sweep = coalescedVisitor(visitor);
  if (slice.firstBoundary === null && sweep.append(first, interpolate(first, centers[1]!, 0.5))) {
    return true;
  }
  const last = slice.lastBoundary ?? centers.length - 2;
  for (let index = (slice.firstBoundary ?? 0) + 1; index <= last; index += 1) {
    const control = centers[index]!;
    const start = interpolate(centers[index - 1]!, control, 0.5);
    const end = interpolate(control, centers[index + 1]!, 0.5);
    if (visitCurve([start, control, end], width, sweep.append)) return true;
    // Live chunks retain four context samples and advance eight samples. These
    // fixed boundaries preserve byte-identical full and sliced serialization.
    if (index % 8 === 3 && sweep.flush()) return true;
  }
  const end = centers[centers.length - 1]!;
  if (
    slice.lastBoundary === null &&
    sweep.append(interpolate(centers[centers.length - 2]!, end, 0.5), end)
  ) {
    return true;
  }
  return sweep.flush();
}

function coalescedVisitor(visitor: (start: PressureCenter, end: PressureCenter) => boolean) {
  let first: PressureCenter | null = null;
  let last: PressureCenter | null = null;
  const flush = (): boolean => {
    if (first === null || last === null) return false;
    const result = visitor(first, last);
    first = null;
    last = null;
    return result;
  };
  return {
    flush,
    append: (start: PressureCenter, end: PressureCenter): boolean => {
      if (first !== null && last !== null && !continuesLine(first, last, end) && flush()) {
        return true;
      }
      first ??= start;
      last = end;
      return false;
    },
  };
}

function continuesLine(a: PressureCenter, b: PressureCenter, c: PressureCenter): boolean {
  const x = b.x - a.x;
  const y = b.y - a.y;
  const p = b.pressure - a.pressure;
  const dx = c.x - b.x;
  const dy = c.y - b.y;
  const dp = c.pressure - b.pressure;
  const tolerance = 1e-10;
  return (
    x * dx + y * dy + p * dp >= 0 &&
    Math.abs(x * dy - y * dx) <= tolerance &&
    Math.abs(x * dp - p * dx) <= tolerance &&
    Math.abs(y * dp - p * dy) <= tolerance
  );
}

function visitCurve(
  curve: readonly [PressureCenter, PressureCenter, PressureCenter],
  width: number,
  visitor: (start: PressureCenter, end: PressureCenter) => boolean,
): boolean {
  const [start, control, end] = curve;
  // Quadratic chord error falls with the square of the subdivision count.
  const error = Math.max(
    Math.hypot(start.x - 2 * control.x + end.x, start.y - 2 * control.y + end.y),
    Math.abs(radius(start, width) - 2 * radius(control, width) + radius(end, width)),
  );
  const steps = Math.min(8, Math.max(1, Math.ceil(Math.sqrt(error / 0.8))));
  let previous = start;
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const next = interpolate(interpolate(start, control, t), interpolate(control, end, t), t);
    if (visitor(previous, next)) return true;
    previous = next;
  }
  return false;
}

function capsule(start: PressureCenter, end: PressureCenter, width: number): string {
  const a = radius(start, width);
  const b = radius(end, width);
  const hull = pressureSweepHull(start, end, a, b);
  if (hull === null) return a >= b ? circle(start, a) : circle(end, b);
  return [
    moveTo(hull[0]),
    lineTo(hull[1]),
    arcTo(b, 0, hull[2], b > a ? 1 : 0),
    lineTo(hull[3]),
    arcTo(a, 0, hull[0], a > b ? 1 : 0),
    "Z",
  ].join("");
}

/** Tangency quadrilateral; null means one disk contains the complete segment. */
export function pressureSweepHull(
  start: PointV1,
  end: PointV1,
  a: number,
  b: number,
): readonly [PointV1, PointV1, PointV1, PointV1] | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= Math.abs(a - b)) return null;
  const ux = dx / distance;
  const uy = dy / distance;
  const slope = (a - b) / distance;
  const normal = Math.sqrt(Math.max(0, 1 - slope * slope));
  const left = { x: ux * slope - uy * normal, y: uy * slope + ux * normal };
  const right = { x: ux * slope + uy * normal, y: uy * slope - ux * normal };
  return [
    offset(start, left, a),
    offset(end, left, b),
    offset(end, right, b),
    offset(start, right, a),
  ];
}

function circle(center: PointV1, size: number): string {
  const left = { x: center.x - size, y: center.y };
  const right = { x: center.x + size, y: center.y };
  return `${moveTo(left)}${arcTo(size, 0, right)}${arcTo(size, 0, left)}Z`;
}

function offset(center: PointV1, direction: PointV1, size: number): PointV1 {
  return { x: center.x + direction.x * size, y: center.y + direction.y * size };
}

function radius(center: PressureCenter, width: number): number {
  return (width * pressureWidthFactor(center.pressure)) / 2;
}

function interpolate(a: PressureCenter, b: PressureCenter, t: number): PressureCenter {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t,
  };
}
