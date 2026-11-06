import {
  canonicalPoint,
  linearPivot,
  pointDistance,
  pointSegmentDistance,
  quadraticPoint,
} from "../geometry/primitives";
import type { PointV1 } from "../schema/types";
import type { RecognizedLinear } from "./recognition-types";
import { hasSmoothArcProfile } from "./smooth-arc-profile";

export function recognizeLinear(points: readonly PointV1[], zoom = 1): RecognizedLinear | null {
  if (points.length < 3) return null;
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const chord = pointDistance(start, end);
  if (chord * zoom < 12) return null;
  const length = pathLength(points);
  if (length > chord * 2.5) return null;
  const times = pathTimes(points, length);
  const weights = times.map(
    (_, index) => times[Math.min(times.length - 1, index + 1)]! - times[Math.max(0, index - 1)]!,
  );
  const lineError = errors(points, (point) => pointSegmentDistance(point, start, end), weights);
  const withinJitter =
    lineError.max < Math.max(2 / zoom, chord * 0.035) &&
    lineError.rms < Math.max(1 / zoom, chord * 0.018);
  // A five-percent quadratic bow has about 3.65-percent RMS chord deviation.
  if (
    length < chord * 1.12 &&
    lineError.max < Math.max(2 / zoom, chord * 0.06) &&
    lineError.rms < Math.max(1 / zoom, chord * 0.04)
  ) {
    if (hasShallowPathDetail(points, times, chord, zoom, !withinJitter)) return null;
    return linearResult(start, end, null);
  }
  if (hasSharpCorner(points, chord)) return null;
  const fitTimes = [...times];
  const control = fitControl(points, fitTimes, weights);
  if (control === null) return null;
  const controlDistance = pointSegmentDistance(control, start, end);
  if (controlDistance > chord * 2) return null;
  const curveError = curveErrors(points, control, times, fitTimes, weights, {
    zoom,
    allowHoldJitter: withinJitter,
  });
  if (curveError === null) return null;
  const exactFit =
    curveError.rms <= Math.max(0.8 / zoom, chord * 0.015) &&
    curveError.max <= Math.max(2 / zoom, chord * 0.04);
  // Circular arches need an approximation because the native model owns one quadratic.
  const accepted =
    exactFit ||
    (curveError.rms <= Math.min(length * 0.035, chord * 0.065) &&
      curveError.max <= Math.min(length * 0.065, chord * 0.12) &&
      hasSmoothArcProfile(points, times));
  if (!accepted) return null;
  return linearResult(start, end, controlDistance <= 2 / zoom ? null : control);
}

function hasShallowPathDetail(
  points: readonly PointV1[],
  times: readonly number[],
  chord: number,
  zoom: number,
  checkCorners: boolean,
): boolean {
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const dx = (end.x - start.x) / chord;
  const dy = (end.y - start.y) / chord;
  const endpointJitter = Math.max(3 / zoom, chord * 0.02);
  // A prior quiet endpoint can become interior when drawing resumes after hold jitter.
  const tolerance = backtrackTolerance(chord, zoom, !checkCorners);
  let furthest = 0;
  let before = 0;
  let after = 1;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index]!;
    if (isEndpointJitter(point, times[index]!, start, end, endpointJitter)) continue;
    const progress = (point.x - start.x) * dx + (point.y - start.y) * dy;
    if (furthest - progress > tolerance) return true;
    furthest = Math.max(furthest, progress);
    if (!checkCorners) continue;
    // Arclength support keeps a retained corner visible despite dense adjacent samples.
    while (before < index - 1 && times[before + 1]! < times[index]! - 0.04) before += 1;
    while (after < points.length - 1 && times[after]! < times[index]! + 0.04) after += 1;
    const a = points[before]!;
    const c = points[after]!;
    const lengths = pointDistance(a, point) * pointDistance(point, c);
    if (lengths === 0) continue;
    if (((point.x - a.x) * (c.x - point.x) + (point.y - a.y) * (c.y - point.y)) / lengths < 0.5)
      return true;
  }
  return furthest - chord > tolerance;
}

function backtrackTolerance(chord: number, zoom: number, allowHoldJitter: boolean): number {
  return allowHoldJitter ? Math.max(2 / zoom, Math.min(14 / zoom, chord * 0.06)) : 2 / zoom;
}

function isEndpointJitter(
  point: PointV1,
  position: number,
  start: PointV1,
  end: PointV1,
  radius: number,
): boolean {
  return (
    (position < 0.04 && (point.x - start.x) ** 2 + (point.y - start.y) ** 2 <= radius ** 2) ||
    (position > 0.96 && (point.x - end.x) ** 2 + (point.y - end.y) ** 2 <= radius ** 2)
  );
}

function curveErrors(
  points: readonly PointV1[],
  control: PointV1,
  times: readonly number[],
  fitTimes: readonly number[],
  weights: readonly number[],
  limits: { zoom: number; allowHoldJitter: boolean },
): { rms: number; max: number } | null {
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const { zoom } = limits;
  const chord = pointDistance(start, end);
  const jitter = Math.max(3 / zoom, chord * 0.02);
  const tolerance = backtrackTolerance(chord, zoom, limits.allowHoldJitter);
  let furthestTime = 0;
  let furthest = start;
  let backtracking = false;
  const result = errors(
    points,
    (point, index) => {
      const t = nearestCurveTime(point, start, control, end, fitTimes[index]!);
      const projected = quadraticPoint(start, control, end, t);
      if (!isEndpointJitter(point, times[index]!, start, end, jitter)) {
        if (t >= furthestTime) {
          furthestTime = t;
          furthest = projected;
        } else if (
          (projected.x - furthest.x) ** 2 + (projected.y - furthest.y) ** 2 >
          tolerance ** 2
        )
          backtracking = true;
      }
      return pointDistance(point, projected);
    },
    weights,
  );
  return backtracking ? null : result;
}

function fitControl(
  points: readonly PointV1[],
  times: number[],
  weights: readonly number[],
): PointV1 | null {
  const start = points[0]!;
  const end = points[points.length - 1]!;
  let control = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  for (let iteration = 0; iteration < 6; iteration += 1) {
    let x = 0;
    let y = 0;
    let divisor = 0;
    for (let index = 1; index < points.length - 1; index += 1) {
      const t = times[index]!;
      const weight = 2 * (1 - t) * t;
      x += weights[index]! * weight * (points[index]!.x - (1 - t) ** 2 * start.x - t ** 2 * end.x);
      y += weights[index]! * weight * (points[index]!.y - (1 - t) ** 2 * start.y - t ** 2 * end.y);
      divisor += weights[index]! * weight ** 2;
    }
    if (divisor < 1e-8) return null;
    control = { x: x / divisor, y: y / divisor };
    for (let index = 1; index < points.length - 1; index += 1) {
      times[index] = nearestCurveTime(points[index]!, start, control, end, times[index]!);
    }
  }
  return refineControl(points, control, times, weights);
}

function refineControl(
  points: readonly PointV1[],
  initial: PointV1,
  times: number[],
  weights: readonly number[],
): PointV1 {
  const start = points[0]!;
  const end = points[points.length - 1]!;
  let control = initial;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    let xx = 0;
    let xy = 0;
    let yy = 0;
    let ex = 0;
    let ey = 0;
    for (let index = 1; index < points.length - 1; index += 1) {
      const point = points[index]!;
      const t = nearestCurveTime(point, start, control, end, times[index]!);
      times[index] = t;
      const curve = quadraticPoint(start, control, end, t);
      const dx = (1 - t) * (control.x - start.x) + t * (end.x - control.x);
      const dy = (1 - t) * (control.y - start.y) + t * (end.y - control.y);
      const length = Math.hypot(dx, dy);
      if (length < 1e-8) continue;
      const nx = -dy / length;
      const ny = dx / length;
      const weight = 2 * (1 - t) * t;
      const error = (curve.x - point.x) * nx + (curve.y - point.y) * ny;
      xx += weights[index]! * (weight * nx) ** 2;
      xy += weights[index]! * weight ** 2 * nx * ny;
      yy += weights[index]! * (weight * ny) ** 2;
      ex += weights[index]! * weight * nx * error;
      ey += weights[index]! * weight * ny * error;
    }
    const determinant = xx * yy - xy ** 2;
    if (determinant < 1e-9) break;
    control = {
      x: control.x - (ex * yy - ey * xy) / determinant,
      y: control.y - (ey * xx - ex * xy) / determinant,
    };
  }
  return control;
}

function nearestCurveTime(
  point: PointV1,
  start: PointV1,
  control: PointV1,
  end: PointV1,
  initial: number,
): number {
  let t = initial;
  const ddx = 2 * (end.x - 2 * control.x + start.x);
  const ddy = 2 * (end.y - 2 * control.y + start.y);
  for (let step = 0; step < 6; step += 1) {
    const p = quadraticPoint(start, control, end, t);
    const dx = 2 * ((1 - t) * (control.x - start.x) + t * (end.x - control.x));
    const dy = 2 * ((1 - t) * (control.y - start.y) + t * (end.y - control.y));
    const denominator = dx ** 2 + dy ** 2 + (p.x - point.x) * ddx + (p.y - point.y) * ddy;
    if (Math.abs(denominator) < 1e-8) break;
    t = Math.max(0, Math.min(1, t - ((p.x - point.x) * dx + (p.y - point.y) * dy) / denominator));
  }
  return t;
}

function hasSharpCorner(points: readonly PointV1[], chord: number): boolean {
  for (let index = 1; index < points.length - 1; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const c = points[index + 1]!;
    const lengths = pointDistance(a, b) * pointDistance(b, c);
    if (lengths < chord ** 2 * 0.000025) continue;
    if (((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / lengths < 0.5) return true;
  }
  return false;
}

function errors(
  points: readonly PointV1[],
  error: (point: PointV1, index: number) => number,
  weights: readonly number[],
): {
  rms: number;
  max: number;
} {
  let square = 0;
  let max = 0;
  let totalWeight = 0;
  for (let index = 0; index < points.length; index += 1) {
    const value = error(points[index]!, index);
    square += value ** 2 * weights[index]!;
    totalWeight += weights[index]!;
    max = Math.max(max, value);
  }
  return { rms: Math.sqrt(square / totalWeight), max };
}

function pathTimes(points: readonly PointV1[], length: number): number[] {
  const times = [0];
  for (let index = 1; index < points.length; index += 1)
    times.push(times[index - 1]! + pointDistance(points[index - 1]!, points[index]!) / length);
  return times;
}

function linearResult(start: PointV1, end: PointV1, bend: PointV1 | null): RecognizedLinear {
  return {
    kind: "line",
    start: canonicalPoint(start),
    end: canonicalPoint(end),
    bend: bend === null ? null : canonicalPoint(bend),
    startNode: "none",
    endNode: "none",
    rotation: 0,
    pivot: linearPivot(start, end, bend),
  };
}

export function pathLength(points: readonly PointV1[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1)
    length += pointDistance(points[index - 1]!, points[index]!);
  return length;
}
