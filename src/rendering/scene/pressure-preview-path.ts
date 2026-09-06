import type { SvgPathPart } from "../../domain/geometry/element-path";
import {
  buildCenterline,
  pressureWidthFactor,
  smoothStrokeCenters,
} from "../../domain/geometry/stroke-path";
import { lineTo, moveTo, quadraticTo } from "../../domain/geometry/svg-format";
import { rotatePointClockwise } from "../../domain/geometry/primitives";
import type { PointV1, StrokeElementV1 } from "../../domain/schema/public";

export interface PressurePreviewPathPart extends SvgPathPart {
  readonly strokeWidth: number;
}

interface PressurePoint extends PointV1 {
  readonly pressure: number;
}

interface PreviewCurve {
  readonly control: PressurePoint | null;
  readonly end: PressurePoint;
  readonly start: PressurePoint;
}

interface CurveFragment {
  readonly band: number;
  readonly command: string;
  readonly start: PointV1;
}

interface FragmentPlan {
  readonly band: number;
  readonly end: number;
  readonly start: number;
}

type CurvePlan = readonly FragmentPlan[] | null;

const PRESSURE_BAND_COUNT = 16;
const LAST_PRESSURE_BAND = PRESSURE_BAND_COUNT - 1;
// Above 6,144 fragments, dense internal curves keep exact geometry with one midpoint width.
const MAXIMUM_FRAGMENT_COUNT = 6_144;

export function buildPressurePreviewPathParts(
  stroke: StrokeElementV1,
): readonly PressurePreviewPathPart[] {
  const centers = previewCenters(stroke);
  const constantPressure = uniformPressure(centers);
  if (constantPressure !== null) {
    return [pressurePart(buildCenterline(centers), stroke.style.width, constantPressure)];
  }

  const curves = centerlineCurves(centers);
  const plans = fragmentPlans(curves, stroke.style.width);
  const commands = Array.from({ length: PRESSURE_BAND_COUNT }, () => [] as string[]);
  let previousBand: number | null = null;
  const appendFragment = (fragment: CurveFragment) => {
    const target = commands[fragment.band]!;
    if (fragment.band !== previousBand) target.push(moveTo(fragment.start));
    target.push(fragment.command);
    previousBand = fragment.band;
  };
  for (let index = 0; index < curves.length; index += 1) {
    const curve = curves[index]!;
    const plan = plans[index] ?? null;
    if (plan === null) {
      appendFragment(curveFragment(curve, 0, 1, pressureBand(pressureAt(curve, 0.5))));
    } else {
      for (const { band, end, start } of plan) {
        appendFragment(curveFragment(curve, start, end, band));
      }
    }
  }
  return commands.flatMap((path, band) =>
    path.length === 0
      ? []
      : [pressurePart(path.join(""), stroke.style.width, band / LAST_PRESSURE_BAND)],
  );
}

function previewCenters(stroke: StrokeElementV1): PressurePoint[] {
  const centers = smoothStrokeCenters(stroke.points);
  return centers.map((center) => {
    const point =
      stroke.rotation === 0 ? center : rotatePointClockwise(center, stroke.pivot, stroke.rotation);
    return { x: point.x, y: point.y, pressure: boundedPressure(center.pressure) };
  });
}

function centerlineCurves(centers: readonly PressurePoint[]): PreviewCurve[] {
  const first = centers[0]!;
  if (centers.length === 1) return [{ control: null, end: first, start: first }];
  if (centers.length === 2) return [{ control: null, end: centers[1]!, start: first }];

  const curves: PreviewCurve[] = [];
  let boundary = midpointPressure(first, centers[1]!);
  curves.push({ control: null, end: boundary, start: first });
  for (let index = 1; index < centers.length - 1; index += 1) {
    const control = centers[index]!;
    const nextBoundary = midpointPressure(control, centers[index + 1]!);
    curves.push({ control, end: nextBoundary, start: boundary });
    boundary = nextBoundary;
  }
  curves.push({ control: null, end: centers[centers.length - 1]!, start: boundary });
  return curves;
}

function fragmentPlans(curves: readonly PreviewCurve[], strokeWidth: number): readonly CurvePlan[] {
  const plans = new Array<CurvePlan>(curves.length).fill(null);
  let fragmentCount = curves.length;
  for (let index = 0; index < curves.length; index += 1) {
    const curve = curves[index]!;
    if (!isTerminalCurve(index, curves.length) && !isSparseCurve(curve, strokeWidth)) continue;
    const detailed = detailedFragmentPlan(curve);
    plans[index] = detailed;
    fragmentCount += detailed.length - 1;
    if (fragmentCount > MAXIMUM_FRAGMENT_COUNT) {
      const bounded = new Array<CurvePlan>(curves.length).fill(null);
      bounded[0] = detailedFragmentPlan(curves[0]!);
      bounded[curves.length - 1] = detailedFragmentPlan(curves[curves.length - 1]!);
      return bounded;
    }
  }
  return plans;
}

function detailedFragmentPlan(curve: PreviewCurve): readonly FragmentPlan[] {
  const boundaries = [0, 1];
  for (let band = 0; band < LAST_PRESSURE_BAND; band += 1) {
    appendPressureRoots(boundaries, curve, (band + 0.5) / LAST_PRESSURE_BAND);
  }
  boundaries.sort((left, right) => left - right);
  const unique = boundaries.filter(
    (value, index) => index === 0 || value - boundaries[index - 1]! > 1e-9,
  );
  return unique.slice(0, -1).map((start, index) => {
    const end = unique[index + 1]!;
    return { band: pressureBand(pressureAt(curve, (start + end) / 2)), end, start };
  });
}

function appendPressureRoots(values: number[], curve: PreviewCurve, threshold: number): void {
  const start = curve.start.pressure;
  const control = curve.control?.pressure ?? (start + curve.end.pressure) / 2;
  const a = start - 2 * control + curve.end.pressure;
  const b = 2 * (control - start);
  const c = start - threshold;
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) appendRoot(values, -c / b);
    return;
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return;
  const root = Math.sqrt(Math.max(0, discriminant));
  appendRoot(values, (-b - root) / (2 * a));
  appendRoot(values, (-b + root) / (2 * a));
}

function appendRoot(values: number[], root: number): void {
  if (root > 1e-9 && root < 1 - 1e-9) values.push(root);
}

function isTerminalCurve(index: number, length: number): boolean {
  return index === 0 || index === length - 1;
}

function isSparseCurve(curve: PreviewCurve, strokeWidth: number): boolean {
  const length =
    pointDistance(curve.start, curve.control ?? curve.end) +
    (curve.control === null ? 0 : pointDistance(curve.control, curve.end));
  return length > Math.max(16, strokeWidth * 2);
}

function pointDistance(left: PointV1, right: PointV1): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function curveFragment(
  curve: PreviewCurve,
  startTime: number,
  endTime: number,
  band: number,
): CurveFragment {
  const start = curvePointAt(curve, startTime);
  const end = curvePointAt(curve, endTime);
  if (curve.control === null) return { band, command: lineTo(end), start };
  if (startTime === 0 && endTime === 1) {
    return { band, command: quadraticTo(curve.control, curve.end), start: curve.start };
  }
  const control = slicedQuadraticControl(curve, startTime, endTime, start);
  return { band, command: quadraticTo(control, end), start };
}

function slicedQuadraticControl(
  curve: PreviewCurve,
  startTime: number,
  endTime: number,
  start: PointV1,
): PointV1 {
  const control = curve.control!;
  const duration = endTime - startTime;
  return {
    x:
      start.x +
      duration *
        ((1 - startTime) * (control.x - curve.start.x) + startTime * (curve.end.x - control.x)),
    y:
      start.y +
      duration *
        ((1 - startTime) * (control.y - curve.start.y) + startTime * (curve.end.y - control.y)),
  };
}

function curvePointAt(curve: PreviewCurve, time: number): PointV1 {
  if (curve.control === null) return interpolatePoint(curve.start, curve.end, time);
  const remaining = 1 - time;
  return {
    x:
      remaining * remaining * curve.start.x +
      2 * remaining * time * curve.control.x +
      time * time * curve.end.x,
    y:
      remaining * remaining * curve.start.y +
      2 * remaining * time * curve.control.y +
      time * time * curve.end.y,
  };
}

function pressureAt(curve: PreviewCurve, time: number): number {
  if (curve.control === null) {
    return curve.start.pressure + (curve.end.pressure - curve.start.pressure) * time;
  }
  const remaining = 1 - time;
  return (
    remaining * remaining * curve.start.pressure +
    2 * remaining * time * curve.control.pressure +
    time * time * curve.end.pressure
  );
}

function midpointPressure(left: PressurePoint, right: PressurePoint): PressurePoint {
  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2,
    pressure: (left.pressure + right.pressure) / 2,
  };
}

function interpolatePoint(start: PointV1, end: PointV1, time: number): PointV1 {
  return {
    x: start.x + (end.x - start.x) * time,
    y: start.y + (end.y - start.y) * time,
  };
}

function uniformPressure(centers: readonly PressurePoint[]): number | null {
  const first = centers[0]!.pressure;
  return centers.every(({ pressure }) => pressure === first) ? first : null;
}

function pressurePart(d: string, width: number, pressure: number): PressurePreviewPathPart {
  return { d, paint: "stroke", strokeWidth: width * pressureWidthFactor(pressure) };
}

function boundedPressure(pressure: number): number {
  return Math.min(1, Math.max(0, pressure));
}

function pressureBand(pressure: number): number {
  return Math.min(LAST_PRESSURE_BAND, Math.max(0, Math.round(pressure * LAST_PRESSURE_BAND)));
}
