import type { SvgPathPart } from "./svg-path-part";
import { buildPressureOutline } from "./pressure-outline";
import type { PointV1, StrokeElementV1 } from "../schema/types";
import { midpoint, rotatePointClockwise } from "./primitives";
import { lineTo, moveTo, quadraticTo } from "./svg-format";

export interface RawStrokeSample extends PointV1 {
  pressure: number;
  time: number;
}

export interface StrokeInputOptions {
  pressureSource: "pen" | "simulated";
  zoom: number;
}

export type StrokePathGeometry = readonly SvgPathPart[];

export interface StrokeCenter extends PointV1 {
  pressure: number;
}

export function smoothStrokeCenters(samples: readonly number[]): StrokeCenter[] {
  assertStrokeSamples(samples);
  const centers: StrokeCenter[] = [];
  const pointCount = samples.length / 3;
  for (let index = 0; index < pointCount; index += 1) {
    centers.push(strokeCenterAt(samples, index, pointCount));
  }
  return centers;
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

export function buildStrokePathParts(stroke: StrokeElementV1): SvgPathPart[] {
  if (!stroke.style.pressureEnabled && stroke.rotation === 0) {
    return [{ d: buildUnrotatedCenterline(stroke.points), paint: "stroke" }];
  }
  const centers = transformedStrokeCenters(stroke);
  return stroke.style.pressureEnabled
    ? buildPressureOutline(centers, stroke.style.width)
    : [{ d: buildCenterline(centers), paint: "stroke" }];
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

function assertStrokeSamples(samples: readonly number[]): void {
  if (samples.length < 3 || samples.length % 3 !== 0 || samples.length > 4096 * 3) {
    throw new RangeError("Stroke samples must contain 1 through 4,096 triples.");
  }
  for (const value of samples) {
    if (!Number.isFinite(value)) throw new RangeError("Stroke samples must be finite.");
  }
}
