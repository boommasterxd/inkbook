import {
  canonicalizeGeometryNumber,
  canonicalizeUnitIntervalNumber,
  isCanonicalGeometryNumber,
  isCanonicalUnitIntervalNumber,
  MAX_ABSOLUTE_COORDINATE,
  MAX_STROKE_POINTS,
} from "../schema/public";
import type { StrokeSamplesV1 } from "../schema/public";
const VALUES_PER_SAMPLE = 3;
const DEFAULT_SAMPLE_CAPACITY = 16;

export type RuntimeStrokeSamples = Readonly<Float64Array>;

export interface StrokeCaptureInstrumentation {
  readonly appendedSamples: number;
  readonly bufferGrowths: number;
  readonly copiedValues: number;
  readonly publishedSamples: number;
}

export function copyStrokeSamplesToRuntime(samples: readonly number[]): RuntimeStrokeSamples {
  assertStrokeSamplesV1(samples);
  return new Float64Array(samples);
}

export function copyRuntimeStrokeSamplesToWire(samples: RuntimeStrokeSamples): StrokeSamplesV1 {
  assertStrokeSamplesV1(samples);
  const copied = new Array<number>(samples.length);
  for (let index = 0; index < samples.length; index += 1) copied[index] = samples[index] as number;
  return copied;
}

export function cloneRuntimeStrokeSamples(samples: RuntimeStrokeSamples): RuntimeStrokeSamples {
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

export class StrokeCaptureBuffer {
  private buffer: Float64Array;
  private bufferGrowths = 0;
  private copiedValues = 0;
  private publishedSamples = 0;
  private usedValues = 0;

  constructor(initialSampleCapacity = DEFAULT_SAMPLE_CAPACITY) {
    if (!Number.isInteger(initialSampleCapacity) || initialSampleCapacity < 1) {
      throw new RangeError("Initial stroke sample capacity must be a positive integer.");
    }
    const boundedCapacity = Math.min(initialSampleCapacity, MAX_STROKE_POINTS);
    this.buffer = new Float64Array(boundedCapacity * VALUES_PER_SAMPLE);
  }

  get sampleCount(): number {
    return this.usedValues / VALUES_PER_SAMPLE;
  }

  get sampleCapacity(): number {
    return this.buffer.length / VALUES_PER_SAMPLE;
  }

  get instrumentation(): StrokeCaptureInstrumentation {
    return Object.freeze({
      appendedSamples: this.sampleCount,
      bufferGrowths: this.bufferGrowths,
      copiedValues: this.copiedValues,
      publishedSamples: this.publishedSamples,
    });
  }

  append(x: number, y: number, pressure: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(pressure)) {
      throw new RangeError("Live stroke samples must be finite.");
    }
    if (Math.abs(x) > MAX_ABSOLUTE_COORDINATE || Math.abs(y) > MAX_ABSOLUTE_COORDINATE) {
      throw new RangeError("Live stroke coordinates exceed the numeric limit.");
    }
    if (pressure < 0 || pressure > 1) {
      throw new RangeError("Live stroke pressure must be from 0 through 1.");
    }
    if (this.sampleCount >= MAX_STROKE_POINTS) {
      throw new RangeError("A stroke cannot contain more than 4096 samples.");
    }
    this.ensureCapacity(this.usedValues + VALUES_PER_SAMPLE);
    this.buffer[this.usedValues] = x;
    this.buffer[this.usedValues + 1] = y;
    this.buffer[this.usedValues + 2] = pressure;
    this.usedValues += VALUES_PER_SAMPLE;
  }

  publish(): RuntimeStrokeSamples {
    if (this.usedValues === 0) throw new RangeError("Cannot publish an empty stroke.");
    const published = new Float64Array(this.usedValues);
    for (let index = 0; index < this.usedValues; index += VALUES_PER_SAMPLE) {
      published[index] = canonicalizeGeometryNumber(this.buffer[index] as number);
      published[index + 1] = canonicalizeGeometryNumber(this.buffer[index + 1] as number);
      published[index + 2] = canonicalizeUnitIntervalNumber(this.buffer[index + 2] as number);
    }
    this.publishedSamples += this.sampleCount;
    return published;
  }

  clear(): void {
    this.usedValues = 0;
  }

  private ensureCapacity(requiredValues: number): void {
    if (requiredValues <= this.buffer.length) return;
    const maximumValues = MAX_STROKE_POINTS * VALUES_PER_SAMPLE;
    const nextValues = Math.min(Math.max(requiredValues, this.buffer.length * 2), maximumValues);
    const nextBuffer = new Float64Array(nextValues);
    nextBuffer.set(this.buffer.subarray(0, this.usedValues));
    this.bufferGrowths += 1;
    this.copiedValues += this.usedValues;
    this.buffer = nextBuffer;
  }
}
