import type { PointV1, StrokeElementV1 } from "../schema/types";
import {
  addPoints,
  midpoint,
  normalizedVector,
  rotatePointClockwise,
  scalePoint,
  subtractPoints,
} from "./primitives";
import { lineTo, moveTo, quadraticTo } from "./svg-format";
import { buildPressureSweep, pressureWidthFactor } from "./pressure-sweep";
export { pressureWidthFactor } from "./pressure-sweep";

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

export function transformedStrokeCenters(stroke: StrokeElementV1): StrokeCenter[] {
  const smoothed = smoothStrokeCenters(stroke.points);
  return stroke.rotation === 0
    ? smoothed
    : smoothed.map((center) => ({
        ...rotatePointClockwise(center, stroke.pivot, stroke.rotation),
        pressure: center.pressure,
      }));
}

export function buildStrokePath(stroke: StrokeElementV1): StrokePathGeometry {
  if (!stroke.style.pressureEnabled && stroke.rotation === 0) {
    return { d: buildUnrotatedCenterline(stroke.points), paint: "stroke" };
  }
  const centers = transformedStrokeCenters(stroke);
  return stroke.style.pressureEnabled
    ? { d: buildPressureOutline(centers, stroke.style.width), paint: "fill" }
    : { d: buildCenterline(centers), paint: "stroke" };
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
  return buildPressureSweep(centers, width);
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

function halfWidth(width: number, pressure: number): number {
  return (width * pressureWidthFactor(pressure)) / 2;
}

function assertStrokeSamples(samples: readonly number[]): void {
  if (samples.length < 3 || samples.length % 3 !== 0 || samples.length > 4096 * 3) {
    throw new RangeError("Stroke samples must contain 1 through 4,096 triples.");
  }
  for (const value of samples) {
    if (!Number.isFinite(value)) throw new RangeError("Stroke samples must be finite.");
  }
}
