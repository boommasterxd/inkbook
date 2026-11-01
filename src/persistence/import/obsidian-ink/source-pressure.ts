import { pressureRadius } from "../../../domain/geometry/pressure/pressure-radius";
import type { StrokeStyleV1 } from "../../../domain/schema/types";
import { PEN_WIDTHS } from "../../../domain/settings/types";
import { finite, invalid, optionalNumber, type SourceRecord } from "./source-values";

interface PressurePoint {
  readonly pressure: number;
}

interface PressureProfile {
  readonly size: number;
  readonly thinning: number;
  readonly penEasing: boolean;
}

interface DiameterRange {
  minimum: number;
  maximum: number;
}

interface RemappedSourcePressure<T extends PressurePoint> {
  readonly points: readonly T[];
  readonly width?: StrokeStyleV1["width"];
}

/** Preserve source nib diameters through the native pressure law and width presets. */
export function* remapSourcePressurePointsSteps<T extends PressurePoint>(
  points: readonly T[],
  style: SourceRecord,
  warnings: Set<string>,
): Generator<void, RemappedSourcePressure<T>> {
  const thinning = optionalNumber(style.thinning, 0.5, "Thinning");
  if (style.brush === "highlighter" || thinning === 0) return { points };
  const profile = pressureProfile(style, thinning);
  const range = yield* diameterRangeSteps(points, profile);
  const width = nativeWidth(range);
  if (clippingError(range, width) > Number.EPSILON * Math.max(1, range.maximum) * 16) {
    warnings.add("Source pressure widths exceeded Inkbook's native pen range and were clipped.");
  }
  const remapped: T[] = [];
  for (const point of points) {
    remapped.push(remapPoint(point, profile, width));
    yield;
  }
  return { points: remapped, width };
}

function pressureProfile(style: SourceRecord, thinning: number): PressureProfile {
  const size = finite(style.size, "Stroke width");
  if (size <= 0 || thinning < -1 || thinning > 1) invalid("Unsupported source stroke profile.");
  const penEasing =
    style.inputKind === "pen" || (style.inputKind !== "mouse" && !style.simulatePressure);
  return { size, thinning, penEasing };
}

function sourceDiameter(pressure: number, profile: PressureProfile): number {
  const response = 0.5 + profile.thinning * (pressure - 0.5);
  const eased = profile.penEasing
    ? 0.65 * response + 0.35 * Math.sin((Math.PI * response) / 2)
    : response;
  const diameter = profile.size * eased * 2;
  if (!Number.isFinite(diameter)) invalid("Unsupported source pressure width.");
  return diameter;
}

function* diameterRangeSteps(
  points: readonly PressurePoint[],
  profile: PressureProfile,
): Generator<void, DiameterRange> {
  const initial = sourceDiameter(points[0]!.pressure, profile);
  const range = { minimum: initial, maximum: initial };
  for (const point of points) {
    includeDiameter(range, sourceDiameter(point.pressure, profile));
    yield;
  }
  return range;
}

function includeDiameter(range: DiameterRange, diameter: number): void {
  range.minimum = Math.min(range.minimum, diameter);
  range.maximum = Math.max(range.maximum, diameter);
}

function nativeWidth(range: DiameterRange): StrokeStyleV1["width"] {
  let result: StrokeStyleV1["width"] = PEN_WIDTHS[0];
  for (const preset of PEN_WIDTHS) {
    if (clippingError(range, preset) < clippingError(range, result)) result = preset;
  }
  return result;
}

function clippingError(range: DiameterRange, width: number): number {
  return Math.max(0, pressureRadius(0, width) * 2 - range.minimum, range.maximum - width);
}

function remapPoint<T extends PressurePoint>(point: T, profile: PressureProfile, width: number): T {
  const minimum = pressureRadius(0, width) * 2;
  const maximum = pressureRadius(1, width) * 2;
  const pressure = (sourceDiameter(point.pressure, profile) - minimum) / (maximum - minimum);
  return { ...point, pressure: Math.max(0, Math.min(1, pressure)) };
}
