import type { PointV1 } from "./types";
import { retainValidatedSampleExtrema, type StrokeSampleExtrema } from "./stroke-sample-extrema";
import { assertStrokeSampleRange } from "./stroke-sample-range-validation";
import { fail, type ValidationContext } from "./validation-internals";

export function* assertStrokeSamplesSteps(
  value: unknown,
  path: string,
  context: ValidationContext,
  offset: PointV1 | undefined,
  samplesPerStep: number,
): Generator<boolean, void> {
  const supported =
    Array.isArray(value) || (context.allowRuntimeStrokeBuffers && value instanceof Float64Array);
  if (!supported || value.length % 3 !== 0) {
    fail("invalid-stroke-samples", path, "Stroke samples must be flat x, y, pressure triples.");
  }
  const pointCount = value.length / 3;
  if (pointCount < 1 || pointCount > context.limits.pointsPerStroke) {
    fail("invalid-stroke-samples", path, "Stroke point count is outside the supported range.");
  }
  context.statistics.strokePoints += pointCount;
  if (context.statistics.strokePoints > context.limits.strokePoints) {
    fail("stroke-point-limit-exceeded", path, "Total stroke point count exceeds the limit.");
  }
  const decodedExtrema = context.parsedProof?.consumeDecodedStrokeSamples(value);
  if (decodedExtrema !== undefined) {
    assertDecodedExtrema(decodedExtrema, path, context.limits.absoluteCoordinate, offset);
    retainValidatedSampleExtrema(value, decodedExtrema);
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const sampleInterval = samplesPerStep > 0 ? Math.max(1, Math.floor(samplesPerStep)) : 256;
  for (let start = 0; start < value.length; start += sampleInterval * 3) {
    const end = Math.min(start + sampleInterval * 3, value.length);
    const bounds = assertStrokeSampleRange(value, path, context, offset, { start, end });
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
    if ((end / 3) % sampleInterval === 0) yield true;
  }
  retainValidatedSampleExtrema(value, { minX, minY, maxX, maxY });
}

function assertDecodedExtrema(
  bounds: StrokeSampleExtrema,
  path: string,
  maximum: number,
  offset: PointV1 | undefined,
): void {
  if (
    bounds.minX < -maximum ||
    bounds.maxX > maximum ||
    bounds.minY < -maximum ||
    bounds.maxY > maximum
  ) {
    fail("invalid-range", path, `Absolute geometry must not exceed ${maximum}.`);
  }
  if (
    offset !== undefined &&
    (bounds.minX + offset.x < -maximum ||
      bounds.maxX + offset.x > maximum ||
      bounds.minY + offset.y < -maximum ||
      bounds.maxY + offset.y > maximum)
  ) {
    fail("invalid-range", path, "Translated stroke coordinates exceed the numeric limit.");
  }
}
