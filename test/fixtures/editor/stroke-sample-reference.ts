import { pointDistance, roundCanonical } from "../../../src/domain/geometry/primitives";
import type { RawStrokeSample, StrokeInputOptions } from "../../../src/domain/geometry/stroke-path";

export function prepareExpectedStrokeSamples(
  samples: readonly RawStrokeSample[],
  options: StrokeInputOptions,
  width = 8,
): number[] {
  if (!Number.isFinite(options.zoom) || options.zoom <= 0) {
    throw new RangeError("Stroke zoom must be a positive finite number.");
  }
  if (samples.length === 0) throw new RangeError("A stroke requires at least one sample.");
  const retained = retainSamples(samples, options);
  const pressures = filteredPressures(retained, options, width);
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
  let mergedTravel = 0;
  for (const sample of samples.slice(1)) {
    const tip = retained[retained.length - 1]!;
    if (options.pressureSource === "simulated" && sample.x === tip.x && sample.y === tip.y) {
      if (retained.length === 1) retained.push({ ...sample, time: tip.time });
      continue;
    }
    mergedTravel += pointDistance(tip, sample) * options.zoom;
    if (retained.length > 1 && mergedTravel < 0.5) {
      retained[retained.length - 1] = sample;
    } else {
      retained.push(sample);
      mergedTravel = 0;
    }
  }
  return retained;
}

function filteredPressures(
  samples: readonly RawStrokeSample[],
  options: StrokeInputOptions,
  width: number,
): number[] {
  const pen = options.pressureSource === "pen";
  const pressures = [pen ? Math.min(1, Math.max(0, samples[0]!.pressure)) : 0.5];
  let filteredSpeed: number | undefined;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const sample = samples[index]!;
    const distance = pointDistance(previous, sample) * options.zoom;
    if (!pen && distance === 0) {
      pressures.push(pressures[index - 1]!);
      continue;
    }
    const elapsed = Math.max(1, sample.time - previous.time);
    const speed = distance / elapsed;
    filteredSpeed =
      filteredSpeed === undefined
        ? speed
        : filteredSpeed + (1 - Math.exp(-elapsed / 32)) * (speed - filteredSpeed);
    const target = pen
      ? Math.min(1, Math.max(0, sample.pressure))
      : 1 / (1 + (filteredSpeed / 0.35) ** 2);
    const smoothingDistance = pen
      ? Math.max(2, 0.35 * width * options.zoom)
      : Math.max(4, 0.5 * width * options.zoom);
    const response = 1 - Math.exp(-distance / smoothingDistance);
    pressures.push(pressures[index - 1]! + response * (target - pressures[index - 1]!));
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
