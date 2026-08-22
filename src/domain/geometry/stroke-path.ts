import type { PointV1, StrokeElementV1 } from "../schema/public";
import {
  addPoints,
  midpoint,
  normalizedVector,
  pointDistance,
  rotatePointClockwise,
  roundCanonical,
  scalePoint,
  subtractPoints,
} from "./primitives";
import { arcTo, lineTo, moveTo, quadraticTo } from "./svg-format";

export interface RawStrokeSample extends PointV1 {
  pressure: number;
  time: number;
}

export interface StrokeInputOptions {
  pressureSource: "pen" | "simulated";
  zoom: number;
}

export interface StrokePathGeometry {
  d: string;
  paint: "fill" | "stroke";
}

export interface StrokeCenter extends PointV1 {
  pressure: number;
}

export interface OutlinePointPair {
  left: PointV1;
  right: PointV1;
  radius: number;
}

export function prepareStrokeSamples(
  samples: readonly RawStrokeSample[],
  options: StrokeInputOptions,
): number[] {
  if (!Number.isFinite(options.zoom) || options.zoom <= 0) {
    throw new RangeError("Stroke zoom must be a positive finite number.");
  }
  if (samples.length === 0) throw new RangeError("A stroke requires at least one sample.");
  const retained = retainStrokeSamples(samples, options.zoom, options.pressureSource);
  const pressures =
    options.pressureSource === "simulated"
      ? simulatedPressures(retained, options.zoom)
      : retained.map((sample) => Math.min(1, Math.max(0, sample.pressure)));
  const result: number[] = [];
  for (let index = 0; index < retained.length; index += 1) {
    const sample = retained[index];
    const pressure = pressures[index];
    if (sample === undefined || pressure === undefined) continue;
    result.push(roundCanonical(sample.x), roundCanonical(sample.y), roundCanonical(pressure, 4));
  }
  return result;
}

export function smoothStrokeCenters(samples: readonly number[]): StrokeCenter[] {
  assertStrokeSamples(samples);
  const centers: StrokeCenter[] = [];
  for (let index = 0; index < samples.length; index += 3) {
    centers.push({ x: samples[index]!, y: samples[index + 1]!, pressure: samples[index + 2]! });
  }
  if (centers.length < 3) return centers;

  return centers.map((center, index) => {
    if (index === 0 || index === centers.length - 1) return center;
    const previous = centers[index - 1]!;
    const next = centers[index + 1]!;
    return {
      x: 0.25 * previous.x + 0.5 * center.x + 0.25 * next.x,
      y: 0.25 * previous.y + 0.5 * center.y + 0.25 * next.y,
      pressure: center.pressure,
    };
  });
}

export function buildStrokePath(stroke: StrokeElementV1): StrokePathGeometry {
  if (!stroke.style.pressureEnabled && stroke.rotation === 0) {
    return { d: buildUnrotatedCenterline(stroke.points), paint: "stroke" };
  }
  if (stroke.style.pressureEnabled && stroke.rotation === 0) {
    const direct = buildUnrotatedPressureOutline(stroke.points, stroke.style.width);
    if (direct !== null) return { d: direct, paint: "fill" };
  }
  const smoothed = smoothStrokeCenters(stroke.points);
  const centers =
    stroke.rotation === 0
      ? smoothed
      : smoothed.map((center) => ({
          ...rotatePointClockwise(center, stroke.pivot, stroke.rotation),
          pressure: center.pressure,
        }));
  return stroke.style.pressureEnabled
    ? { d: buildPressureOutline(centers, stroke.style.width), paint: "fill" }
    : { d: buildCenterline(centers), paint: "stroke" };
}

function buildUnrotatedPressureOutline(samples: readonly number[], width: number): string | null {
  assertStrokeSamples(samples);
  const pointCount = samples.length / 3;
  const centers = Array.from({ length: pointCount }, (_, index) =>
    strokeCenterAt(samples, index, pointCount),
  );
  if (pointCount === 1) return buildPressureOutline(centers, width);
  const pairs = buildDirectOutlinePairs(centers, width);
  if (pairs === null) return null;
  return buildClosedOutlinePath(pairs);
}

function buildDirectOutlinePairs(
  centers: readonly StrokeCenter[],
  width: number,
): OutlinePointPair[] | null {
  const pairs = new Array<OutlinePointPair>(centers.length);
  for (let index = 0; index < centers.length; index += 1) {
    const center = centers[index]!;
    const previous = centers[Math.max(0, index - 1)]!;
    const next = centers[Math.min(centers.length - 1, index + 1)]!;
    if (index > 0 && center.x === previous.x && center.y === previous.y) return null;
    const tangent = normalizedVector(subtractPoints(next, previous));
    if (tangent === null) return null;
    const radius = halfWidth(width, center.pressure);
    const offset = scalePoint({ x: -tangent.y, y: tangent.x }, radius);
    pairs[index] = {
      left: addPoints(center, offset),
      radius,
      right: subtractPoints(center, offset),
    };
  }
  return pairs;
}

function buildUnrotatedCenterline(samples: readonly number[]): string {
  assertStrokeSamples(samples);
  const pointCount = samples.length / 3;
  const first = strokeCenterAt(samples, 0, pointCount);
  if (pointCount === 1) return `${moveTo(first)}${lineTo(first)}`;
  const second = strokeCenterAt(samples, 1, pointCount);
  if (pointCount === 2) return `${moveTo(first)}${lineTo(second)}`;

  const commands = [moveTo(first), lineTo(midpoint(first, second))];
  let current = second;
  for (let index = 1; index < pointCount - 1; index += 1) {
    const next = strokeCenterAt(samples, index + 1, pointCount);
    commands.push(quadraticTo(current, midpoint(current, next)));
    current = next;
  }
  commands.push(lineTo(current));
  return commands.join("");
}

function strokeCenterAt(
  samples: readonly number[],
  pointIndex: number,
  pointCount: number,
): StrokeCenter {
  const offset = pointIndex * 3;
  if (pointIndex === 0 || pointIndex === pointCount - 1) {
    return { x: samples[offset]!, y: samples[offset + 1]!, pressure: samples[offset + 2]! };
  }
  return {
    x: samples[offset - 3]! * 0.25 + samples[offset]! * 0.5 + samples[offset + 3]! * 0.25,
    y: samples[offset - 2]! * 0.25 + samples[offset + 1]! * 0.5 + samples[offset + 4]! * 0.25,
    pressure: samples[offset + 2]!,
  };
}

export function buildCenterline(centers: readonly PointV1[]): string {
  const first = centers[0];
  if (first === undefined) throw new RangeError("A centerline requires at least one point.");
  if (centers.length === 1) return `${moveTo(first)}${lineTo(first)}`;
  if (centers.length === 2) return `${moveTo(first)}${lineTo(centers[1]!)}`;

  const commands = [moveTo(first), lineTo(midpoint(first, centers[1]!))];
  for (let index = 1; index < centers.length - 1; index += 1) {
    commands.push(quadraticTo(centers[index]!, midpoint(centers[index]!, centers[index + 1]!)));
  }
  commands.push(lineTo(centers[centers.length - 1]!));
  return commands.join("");
}

export function buildPressureOutline(centers: readonly StrokeCenter[], width: number): string {
  const first = centers[0];
  if (first === undefined) throw new RangeError("A pressure outline requires at least one point.");
  if (centers.length === 1) {
    const radius = halfWidth(width, first.pressure);
    const left = { x: first.x - radius, y: first.y };
    const right = { x: first.x + radius, y: first.y };
    return `${moveTo(left)}${arcTo(radius, 1, right)}${arcTo(radius, 1, left)}Z`;
  }

  const pairs = buildPressureOutlinePairs(centers, width);
  return buildClosedOutlinePath(pairs);
}

function buildClosedOutlinePath(pairs: readonly OutlinePointPair[]): string {
  const left = pairs.map((pair) => pair.left);
  const right = pairs.map((pair) => pair.right).reverse();
  const endPair = pairs[pairs.length - 1]!;
  const startPair = pairs[0]!;
  return [
    buildOpenMidpointPath(left),
    arcTo(endPair.radius, 1, endPair.right),
    appendMidpointPath(right),
    arcTo(startPair.radius, 1, startPair.left),
    "Z",
  ].join("");
}

function retainStrokeSamples(
  samples: readonly RawStrokeSample[],
  zoom: number,
  pressureSource: StrokeInputOptions["pressureSource"],
): RawStrokeSample[] {
  for (const sample of samples) assertRawSample(sample, pressureSource);
  if (samples.length === 1) return [samples[0]!];

  const retained: RawStrokeSample[] = [samples[0]!];
  for (let index = 1; index < samples.length - 1; index += 1) {
    const sample = samples[index]!;
    const tip = retained[retained.length - 1]!;
    if (pointDistance(tip, sample) * zoom < 0.5 && retained.length > 1) {
      retained[retained.length - 1] = sample;
    } else {
      retained.push(sample);
    }
  }

  const finalSample = samples[samples.length - 1]!;
  const tip = retained[retained.length - 1]!;
  if (retained.length > 1 && pointDistance(tip, finalSample) * zoom < 0.5) {
    retained[retained.length - 1] = finalSample;
  } else {
    retained.push(finalSample);
  }
  return retained;
}

function simulatedPressures(samples: readonly RawStrokeSample[], zoom: number): number[] {
  const pressures = [0.5];
  for (let index = 1; index < samples.length; index += 1) {
    const previousSample = samples[index - 1]!;
    const sample = samples[index]!;
    const elapsed = Math.max(1, sample.time - previousSample.time);
    const speed = (pointDistance(previousSample, sample) * zoom) / elapsed;
    const target = Math.min(1, Math.max(0.25, 1 - speed / 1.5));
    pressures.push(0.7 * pressures[index - 1]! + 0.3 * target);
  }
  return pressures;
}

export function buildPressureOutlinePairs(
  centers: readonly StrokeCenter[],
  width: number,
): OutlinePointPair[] {
  const tangents = strokeTangents(centers);
  return centers.map((center, index) => {
    const tangent = tangents[index] as PointV1;
    const perpendicular = { x: -tangent.y, y: tangent.x };
    const radius = halfWidth(width, center.pressure);
    const offset = scalePoint(perpendicular, radius);
    return { left: addPoints(center, offset), right: subtractPoints(center, offset), radius };
  });
}

function strokeTangents(centers: readonly StrokeCenter[]): PointV1[] {
  const tangents = new Array<PointV1 | undefined>(centers.length);
  let lastValid: PointV1 | undefined;
  for (let index = 0; index < centers.length; index += 1) {
    const tangent = isRepeatedCenter(centers, index) ? null : tangentAt(centers, index);
    if (tangent !== null) lastValid = tangent;
    tangents[index] = lastValid;
  }

  let nextValid: PointV1 | undefined;
  for (let index = centers.length - 1; index >= 0; index -= 1) {
    const tangent = isRepeatedCenter(centers, index) ? null : tangentAt(centers, index);
    if (tangent !== null) nextValid = tangent;
    if (tangents[index] === undefined) tangents[index] = nextValid;
    if (tangents[index] === undefined) tangents[index] = { x: 1, y: 0 };
  }
  return tangents as PointV1[];
}

function isRepeatedCenter(centers: readonly StrokeCenter[], index: number): boolean {
  if (index === 0) return false;
  const current = centers[index]!;
  const previous = centers[index - 1]!;
  return current.x === previous.x && current.y === previous.y;
}

function tangentAt(centers: readonly StrokeCenter[], index: number): PointV1 | null {
  const previous = centers[Math.max(0, index - 1)]!;
  const next = centers[Math.min(centers.length - 1, index + 1)]!;
  return (
    normalizedVector(subtractPoints(next, previous)) ??
    normalizedVector(subtractPoints(centers[index]!, previous)) ??
    normalizedVector(subtractPoints(next, centers[index]!))
  );
}

function buildOpenMidpointPath(points: readonly PointV1[]): string {
  return `${moveTo(points[0]!)}${appendMidpointPath(points)}`;
}

function appendMidpointPath(points: readonly PointV1[]): string {
  if (points.length === 1) return "";
  if (points.length === 2) return lineTo(points[1]!);
  const commands = [lineTo(midpoint(points[0]!, points[1]!))];
  for (let index = 1; index < points.length - 1; index += 1) {
    commands.push(quadraticTo(points[index]!, midpoint(points[index]!, points[index + 1]!)));
  }
  commands.push(lineTo(points[points.length - 1]!));
  return commands.join("");
}

function halfWidth(width: number, pressure: number): number {
  return (width * (0.35 + 0.65 * Math.min(1, Math.max(0, pressure)))) / 2;
}

function assertRawSample(
  sample: RawStrokeSample,
  source: StrokeInputOptions["pressureSource"],
): void {
  if (![sample.x, sample.y, sample.time].every(Number.isFinite)) {
    throw new RangeError("Stroke position and time must be finite.");
  }
  if (source === "pen" && !Number.isFinite(sample.pressure)) {
    throw new RangeError("Pen pressure must be finite.");
  }
}

function assertStrokeSamples(samples: readonly number[]): void {
  if (samples.length < 3 || samples.length % 3 !== 0 || samples.length > 4096 * 3) {
    throw new RangeError("Stroke samples must contain 1 through 4,096 triples.");
  }
  for (const value of samples) {
    if (!Number.isFinite(value)) throw new RangeError("Stroke samples must be finite.");
  }
}
