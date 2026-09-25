import type { PreparedPressureGeometryPort } from "./prepared-pressure-geometry";
import { simplifyStrokeCenters } from "./stroke-simplification";
import { MAX_STROKE_POINTS } from "../schema/constants";
import type { SvgPathPart } from "./svg-path-part";
import { buildPressureOutline } from "./pressure-outline";
import type { PointV1, StrokeElementV1 } from "../schema/types";
import { rotatePointClockwise } from "./primitives";
import { lineTo, moveTo } from "./svg-format";

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

export function buildStrokePathParts(
  stroke: StrokeElementV1,
  pressureGeometry?: PreparedPressureGeometryPort,
): SvgPathPart[] {
  const centers = transformedStrokeCenters(stroke);
  return stroke.style.pressureEnabled
    ? buildPressureOutline(centers, stroke.style.width, pressureGeometry)
    : [
        {
          d: buildCenterline(simplifyStrokeCenters(centers, stroke.style.width, false)),
          paint: "stroke",
        },
      ];
}

export function strokeCenterAt(
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
  return moveTo(first) + centers.slice(1).map(lineTo).join("");
}

function assertStrokeSamples(samples: readonly number[]): void {
  if (samples.length < 3 || samples.length % 3 !== 0 || samples.length > MAX_STROKE_POINTS * 3) {
    throw new RangeError(`Stroke samples must contain 1 through ${MAX_STROKE_POINTS} triples.`);
  }
  for (const value of samples) {
    if (!Number.isFinite(value)) throw new RangeError("Stroke samples must be finite.");
  }
}
