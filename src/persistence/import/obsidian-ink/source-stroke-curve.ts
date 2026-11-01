import { finite, invalid, optionalNumber, type SourceRecord } from "./source-values";
import type { StrokeStyleV1 } from "../../../domain/schema/types";
import { remapSourcePressurePointsSteps } from "./source-pressure";

/*
 * The Official compatibility profile follows perfect-freehand 1.2.3's mathematical
 * streamline and corner rules. Copyright (c) 2021 Stephen Ruiz Ltd.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export interface SourceStrokeCurvePoint {
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
}

export type SourceStrokeCurveSegment =
  | {
      readonly kind: "line";
      readonly end: SourceStrokeCurvePoint;
      readonly sharpEnd?: boolean;
    }
  | {
      readonly kind: "quadratic";
      readonly control: SourceStrokeCurvePoint;
      readonly end: SourceStrokeCurvePoint;
      readonly sharpEnd?: boolean;
    };

export interface SourceStrokeCurve {
  readonly start: SourceStrokeCurvePoint;
  readonly segments: readonly SourceStrokeCurveSegment[];
  readonly approximate: boolean;
  readonly targetWidth?: StrokeStyleV1["width"];
}

interface SourceVertex extends SourceStrokeCurvePoint {
  readonly distance: number;
  readonly runningLength: number;
  readonly vectorX: number;
  readonly vectorY: number;
  sharp: boolean;
}

interface SourceProfile {
  readonly size: number;
  readonly streamline: number;
  readonly thinning: number;
  readonly simulatePressure: boolean;
}

/** Reconstructs source curve sections before the native brush applies its own filter. */
export function* sourceStrokeCurveSteps(
  points: readonly number[],
  style: SourceRecord,
  version: number,
  warnings: Set<string>,
): Generator<void, SourceStrokeCurve> {
  const profile = sourceProfile(style);
  const input = yield* readPointsSteps(points);
  // Filled source outlines do not define a unique center curve, even when their
  // streamline and sharp-corner decisions are reproduced exactly.
  const approximate = version === 1 || profile.thinning !== 0;
  let vertices = input;
  if (input.length > 2) {
    const prepared = version === 1 ? input : yield* thinSourcePointsSteps(input, profile.size);
    vertices = prepared;
    if (version === 1 || profile.thinning !== 0) {
      vertices = yield* streamlineSourceSteps(prepared, profile, version !== 1);
      yield* classifyCornersSteps(vertices);
      if (profile.simulatePressure) yield* simulatePressureSteps(vertices, profile.size);
    }
  }
  const mapped = yield* remapSourcePressurePointsSteps(vertices, style, warnings);
  const curve = yield* buildCurveSteps(mapped.points, approximate, version === 1);
  return { ...curve, ...(mapped.width === undefined ? {} : { targetWidth: mapped.width }) };
}

function sourceProfile(style: SourceRecord): SourceProfile {
  const size = finite(style.size, "Stroke width");
  const streamline = optionalNumber(style.streamline, 0.5, "Streamline");
  const thinning = optionalNumber(style.thinning, 0.5, "Thinning");
  const simulation = style.simulatePressure ?? true;
  if (size <= 0 || streamline < 0 || streamline > 1 || thinning < -1 || thinning > 1) {
    invalid("Unsupported source stroke profile.");
  }
  if (typeof simulation !== "boolean") invalid("Invalid source pressure simulation.");
  return { size, streamline, thinning, simulatePressure: simulation };
}

function* readPointsSteps(points: readonly number[]): Generator<void, SourceVertex[]> {
  if (points.length === 0 || points.length % 3 !== 0) invalid("Incomplete source stroke.");
  const result: SourceVertex[] = [];
  for (let index = 0; index < points.length; index += 3) {
    result.push({
      x: points[index]!,
      y: points[index + 1]!,
      pressure: points[index + 2]!,
      distance: 0,
      runningLength: 0,
      vectorX: 0,
      vectorY: 0,
      sharp: false,
    });
    yield;
  }
  return result;
}

function shortCurve(
  points: readonly SourceStrokeCurvePoint[],
  approximate: boolean,
): SourceStrokeCurve {
  return {
    start: points[0]!,
    segments: points.length === 1 ? [] : [{ kind: "line", end: points[points.length - 1]! }],
    approximate,
  };
}

function* thinSourcePointsSteps(
  points: readonly SourceVertex[],
  size: number,
): Generator<void, SourceVertex[]> {
  const result = [points[0]!];
  const minimumSquared = (size / 6) ** 2;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index]!;
    const previous = result[result.length - 1]!;
    if ((point.x - previous.x) ** 2 + (point.y - previous.y) ** 2 >= minimumSquared) {
      result.push(point);
    }
    yield;
  }
  result.push(points[points.length - 1]!);
  return result;
}

/** Custom pressure uses an independent approximation, without the SDK outline port. */
function* streamlineSourceSteps(
  input: readonly SourceVertex[],
  profile: SourceProfile,
  custom: boolean,
): Generator<void, SourceVertex[]> {
  const result: SourceVertex[] = [{ ...input[0]!, sharp: false }];
  const factor = 0.15 + (1 - profile.streamline) * 0.85;
  const lastIndex = input.length - 1;
  let runningLength = 0;
  let minimumReached = false;
  for (let index = 1; index <= lastIndex; index += 1) {
    const previous = result[result.length - 1]!;
    const point = input[index]!;
    const vertex = streamedVertex(previous, point, index === lastIndex ? 1 : factor);
    runningLength += vertex.distance;
    const awaitingMinimum = custom ? index < 4 : !minimumReached && index < lastIndex;
    if (vertex.distance !== 0 && !(awaitingMinimum && runningLength < profile.size)) {
      result.push({ ...vertex, runningLength });
      minimumReached = true;
    }
    yield;
  }
  return result;
}

function streamedVertex(previous: SourceVertex, point: SourceVertex, factor: number): SourceVertex {
  const x = previous.x + (point.x - previous.x) * factor;
  const y = previous.y + (point.y - previous.y) * factor;
  const distance = Math.hypot(x - previous.x, y - previous.y);
  return {
    ...point,
    x,
    y,
    distance,
    vectorX: distance === 0 ? 0 : (previous.x - x) / distance,
    vectorY: distance === 0 ? 0 : (previous.y - y) / distance,
  };
}

function* classifyCornersSteps(points: SourceVertex[]): Generator<void> {
  if (points.length <= 2) return;
  const totalLength = points[points.length - 1]!.runningLength;
  let previous = points[1]!;
  let previousSharp = false;
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]!;
    if (totalLength - current.runningLength >= 3) {
      const next = points[index + 1]!;
      const nextSharp = vectorDot(current, next) < 0;
      current.sharp = nextSharp || (vectorDot(current, previous) < 0 && !previousSharp);
      if (current.sharp) previousSharp ||= nextSharp;
      else {
        previousSharp = false;
        previous = current;
      }
    }
    yield;
  }
}

function vectorDot(first: SourceVertex, second: SourceVertex): number {
  return first.vectorX * second.vectorX + first.vectorY * second.vectorY;
}

function* simulatePressureSteps(points: SourceVertex[], size: number): Generator<void> {
  let previous = points[0]!.pressure;
  for (let index = 0; index < Math.min(10, points.length); index += 1) {
    previous = (previous + simulatedPressure(previous, points[index]!.distance, size)) / 2;
    yield;
  }
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const pressure = simulatedPressure(previous, point.distance, size);
    points[index] = { ...point, pressure };
    if (!point.sharp) previous = pressure;
    yield;
  }
}

function simulatedPressure(previous: number, distance: number, size: number): number {
  const speed = Math.min(1, distance / size);
  return Math.min(1, previous + (1 - speed - previous) * speed * 0.275);
}

function* buildCurveSteps(
  points: readonly SourceVertex[],
  approximate: boolean,
  averageOfficialStart = false,
): Generator<void, SourceStrokeCurve> {
  if (points.length <= 2) return shortCurve(points, approximate);
  const segments: SourceStrokeCurveSegment[] = [];
  if (averageOfficialStart && !points[1]!.sharp) {
    // The two filled sides start their first smooth Q at P0 and midpoint(P0,P1).
    // Average those starts, retaining P0 with a line; this is a curve profile,
    // not an assertion that the source fill has a unique medial axis.
    segments.push({ kind: "line", end: midpoint(points[0]!, midpoint(points[0]!, points[1]!)) });
  }
  for (let index = 1; index < points.length - 1; index += 1) {
    const control = points[index]!;
    if (control.sharp) {
      segments.push({ kind: "quadratic", control, end: control, sharpEnd: true });
    }
    segments.push({ kind: "quadratic", control, end: midpoint(control, points[index + 1]!) });
    yield;
  }
  segments.push({ kind: "line", end: points[points.length - 1]! });
  return { start: points[0]!, segments, approximate };
}

function midpoint(
  first: SourceStrokeCurvePoint,
  second: SourceStrokeCurvePoint,
): SourceStrokeCurvePoint {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
    pressure: (first.pressure + second.pressure) / 2,
  };
}
