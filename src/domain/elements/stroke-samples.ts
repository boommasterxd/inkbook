import {
  isCanonicalGeometryNumber,
  isCanonicalUnitIntervalNumber,
  MAX_ABSOLUTE_COORDINATE,
  MAX_STROKE_POINTS,
} from "../schema/public";
const VALUES_PER_SAMPLE = 3;

export type RuntimeStrokeSamples = Readonly<Float64Array>;

export function copyStrokeSamplesToRuntime(samples: readonly number[]): RuntimeStrokeSamples {
  assertStrokeSamplesV1(samples);
  return new Float64Array(samples);
}

export function assertStrokeSamplesV1(samples: ArrayLike<number>): void {
  if (
    samples.length < VALUES_PER_SAMPLE ||
    samples.length % VALUES_PER_SAMPLE !== 0 ||
    samples.length / VALUES_PER_SAMPLE > MAX_STROKE_POINTS
  ) {
    throw new RangeError("Stroke samples must contain 1 through 4096 x, y, pressure triples.");
  }
  for (let index = 0; index < samples.length; index += VALUES_PER_SAMPLE) {
    if (
      !isCanonicalGeometryNumber(samples[index]) ||
      !isCanonicalGeometryNumber(samples[index + 1]) ||
      Math.abs(samples[index] as number) > MAX_ABSOLUTE_COORDINATE ||
      Math.abs(samples[index + 1] as number) > MAX_ABSOLUTE_COORDINATE
    ) {
      throw new RangeError("Stroke coordinates must be finite canonical geometry.");
    }
    if (!isCanonicalUnitIntervalNumber(samples[index + 2])) {
      throw new RangeError("Stroke pressure must be a canonical number from 0 through 1.");
    }
  }
}
