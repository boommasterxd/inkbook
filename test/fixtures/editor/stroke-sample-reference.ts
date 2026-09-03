import { pointDistance, roundCanonical } from "../../../src/domain/geometry/primitives";
import type { RawStrokeSample, StrokeInputOptions } from "../../../src/domain/geometry/stroke-path";

export function prepareExpectedStrokeSamples(
  samples: readonly RawStrokeSample[],
  options: StrokeInputOptions,
): number[] {
  if (!Number.isFinite(options.zoom) || options.zoom <= 0) {
    throw new RangeError("Stroke zoom must be a positive finite number.");
  }
  if (samples.length === 0) throw new RangeError("A stroke requires at least one sample.");
  const retained = retainSamples(samples, options);
  const pressures =
    options.pressureSource === "simulated"
      ? simulatedPressures(retained, options.zoom)
      : retained.map((sample) => Math.min(1, Math.max(0, sample.pressure)));
  return retained.flatMap((sample, index) => [
    roundCanonical(sample.x),
    roundCanonical(sample.y),
    roundCanonical(pressures[index]!, 4),
  ]);
}

function retainSamples(
  samples: readonly RawStrokeSample[],
  options: StrokeInputOptions,
): RawStrokeSample[] {
  for (const sample of samples) assertSample(sample, options.pressureSource);
  if (samples.length === 1) return [samples[0]!];
  const retained = [samples[0]!];
  for (const sample of samples.slice(1, -1)) {
    const tip = retained[retained.length - 1]!;
    if (retained.length > 1 && pointDistance(tip, sample) * options.zoom < 0.5) {
      retained[retained.length - 1] = sample;
    } else {
      retained.push(sample);
    }
  }
  const finalSample = samples[samples.length - 1]!;
  const tip = retained[retained.length - 1]!;
  if (retained.length > 1 && pointDistance(tip, finalSample) * options.zoom < 0.5) {
    retained[retained.length - 1] = finalSample;
  } else {
    retained.push(finalSample);
  }
  return retained;
}

function simulatedPressures(samples: readonly RawStrokeSample[], zoom: number): number[] {
  const pressures = [0.5];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const sample = samples[index]!;
    const elapsed = Math.max(1, sample.time - previous.time);
    const speed = (pointDistance(previous, sample) * zoom) / elapsed;
    const target = Math.min(1, Math.max(0.25, 1 - speed / 1.5));
    pressures.push(0.7 * pressures[index - 1]! + 0.3 * target);
  }
  return pressures;
}

function assertSample(sample: RawStrokeSample, source: StrokeInputOptions["pressureSource"]): void {
  if (![sample.x, sample.y, sample.time].every(Number.isFinite)) {
    throw new RangeError("Stroke position and time must be finite.");
  }
  if (source === "pen" && !Number.isFinite(sample.pressure)) {
    throw new RangeError("Pen pressure must be finite.");
  }
}
