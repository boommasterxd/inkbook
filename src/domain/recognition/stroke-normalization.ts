import { includeBoundsPoint, pointDistance, pointSegmentDistance } from "../geometry/primitives";
import type { PointV1 } from "../schema/types";
import {
  mergeRecognitionCorners,
  retainRecognitionCorner,
  type PositionedRecognitionPath,
  type RecognitionCorner,
} from "./recognition-corners";

interface StrokeMeasure {
  length: number;
  diagonal: number;
}

export interface NormalizedRecognitionStroke extends StrokeMeasure {
  points: PointV1[];
}

const MAX_NORMALIZED_POINTS = 256;
const RESAMPLED_SEGMENTS = 160;
const END_DETAIL_SEGMENTS = 32;
export function* normalizeRecognitionStrokeSteps(
  samples: readonly number[],
  zoom: number,
): Generator<void, NormalizedRecognitionStroke | null> {
  if (samples.length < 9 || samples.length % 3 !== 0 || !Number.isFinite(zoom) || zoom <= 0)
    return null;
  const measure = yield* measureStrokeSteps(samples);
  if (
    measure === null ||
    !Number.isFinite(measure.length) ||
    !Number.isFinite(measure.diagonal) ||
    measure.diagonal * zoom < 12 ||
    measure.length * zoom < 18
  )
    return null;
  const path = yield* resampleStrokeSteps(samples, measure.length, zoom);
  if (path === null || !(yield* preservesOriginalPathSteps(samples, path, measure.diagonal, zoom)))
    return null;
  return { ...measure, points: path.points };
}

function* measureStrokeSteps(samples: readonly number[]): Generator<void, StrokeMeasure | null> {
  let previous: PointV1 | null = null;
  let length = 0;
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let index = 0; index < samples.length; index += 3) {
    const point = { x: samples[index]!, y: samples[index + 1]! };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    if (previous !== null) length += pointDistance(previous, point);
    includeBoundsPoint(bounds, point);
    previous = point;
    yield;
  }
  return { length, diagonal: Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) };
}

function* resampleStrokeSteps(
  samples: readonly number[],
  length: number,
  zoom: number,
): Generator<void, PositionedRecognitionPath | null> {
  const path = { points: [{ x: samples[0]!, y: samples[1]! }], positions: [0] };
  const targets = samplePositions(length, zoom);
  const corners: RecognitionCorner[] = [];
  let previous = path.points[0]!;
  let beforePrevious: PointV1 | null = null;
  let previousSegment = 0;
  let travelled = 0;
  let targetIndex = 1;
  for (let index = 3; index < samples.length; index += 3) {
    const point = { x: samples[index]!, y: samples[index + 1]! };
    const segment = pointDistance(previous, point);
    if (beforePrevious !== null && previousSegment > 1e-7 && segment > 1e-7) {
      const cosine =
        ((previous.x - beforePrevious.x) * (point.x - previous.x) +
          (previous.y - beforePrevious.y) * (point.y - previous.y)) /
        (previousSegment * segment);
      if (cosine < 0.75)
        retainRecognitionCorner(corners, {
          point: previous,
          position: travelled,
          salience: (1 - cosine) * Math.min(previousSegment, segment),
        });
    }
    while (
      targetIndex < targets.length &&
      targets[targetIndex]! <= travelled + segment &&
      segment > 0
    ) {
      const t = (targets[targetIndex]! - travelled) / segment;
      appendDistinct(
        path,
        {
          x: previous.x + (point.x - previous.x) * t,
          y: previous.y + (point.y - previous.y) * t,
        },
        targets[targetIndex]!,
      );
      targetIndex += 1;
    }
    travelled += segment;
    if (segment > 0) {
      beforePrevious = previous;
      previous = point;
      previousSegment = segment;
    }
    yield;
  }
  appendDistinct(path, previous, travelled);
  const merged = mergeRecognitionCorners(path, corners);
  return merged.points.length <= MAX_NORMALIZED_POINTS ? merged : null;
}

function* preservesOriginalPathSteps(
  samples: readonly number[],
  path: PositionedRecognitionPath,
  diagonal: number,
  zoom: number,
): Generator<void, boolean> {
  // A raw point and its sampled segment can each carry two CSS pixels of input jitter.
  // The relative allowance stays below the recognizer's tightest 1.5% fit residual.
  const tolerance = Math.max(4 / zoom, diagonal * 0.005);
  let previous: PointV1 | null = null;
  let travelled = 0;
  let segment = 0;
  for (let index = 0; index < samples.length; index += 3) {
    const point = { x: samples[index]!, y: samples[index + 1]! };
    if (previous !== null) travelled += pointDistance(previous, point);
    while (segment < path.points.length - 2 && path.positions[segment + 1]! < travelled)
      segment += 1;
    if (pointSegmentDistance(point, path.points[segment]!, path.points[segment + 1]!) > tolerance)
      return false;
    previous = point;
    yield;
  }
  return true;
}

function samplePositions(length: number, zoom: number): number[] {
  const positions = Array.from(
    { length: RESAMPLED_SEGMENTS + 1 },
    (_, index) => (length * index) / RESAMPLED_SEGMENTS,
  );
  const detailRange = Math.min(length / 2, 48 / zoom);
  for (let index = 1; index <= END_DETAIL_SEGMENTS; index += 1) {
    const offset = (detailRange * index) / END_DETAIL_SEGMENTS;
    positions.push(offset, length - offset);
  }
  return [...new Set(positions)].sort((a, b) => a - b);
}

function appendDistinct(path: PositionedRecognitionPath, point: PointV1, position: number): void {
  if (pointDistance(path.points[path.points.length - 1]!, point) > 1e-7) {
    path.points.push(point);
    path.positions.push(position);
  }
}
