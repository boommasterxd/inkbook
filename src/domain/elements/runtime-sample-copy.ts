import { MAX_STROKE_POINTS } from "../schema/constants";

export type SampleSource = readonly number[] | Readonly<Float64Array>;
export type SampleBuffer = number[] | Float64Array;

export const DEFAULT_SAMPLE_COPY_STEP = 256;
const MAX_SAMPLE_VALUES = MAX_STROKE_POINTS * 3;
const immutableSampleSources = new WeakSet<object>();

export interface SampleCopyProof {
  readonly source: SampleSource;
  eligible: boolean;
}

export function isImmutableStrokeSampleSource(points: object): boolean {
  return immutableSampleSources.has(points);
}

export function createSampleCopyProof(source: SampleSource): SampleCopyProof {
  const length = Array.isArray(source)
    ? Object.getOwnPropertyDescriptor(source, "length")
    : undefined;
  return {
    source,
    eligible:
      Array.isArray(source) &&
      !Object.isExtensible(source) &&
      length?.writable === false &&
      length.configurable === false,
  };
}

export function finishSampleCopyProof(proof: SampleCopyProof): void {
  if (proof.eligible) immutableSampleSources.add(proof.source);
}

export function assertSampleCopyInput(points: SampleSource, samplesPerStep: number): number {
  if (!Array.isArray(points) && !(points instanceof Float64Array)) {
    throw new TypeError("Stroke samples must be an array or Float64Array.");
  }
  const length = points.length;
  if (!Number.isInteger(length) || length < 3 || length % 3 !== 0 || length > MAX_SAMPLE_VALUES) {
    throw new RangeError("Stroke sample count exceeds the supported triple buffer range.");
  }
  if (
    !Number.isInteger(samplesPerStep) ||
    samplesPerStep < 1 ||
    samplesPerStep > MAX_STROKE_POINTS
  ) {
    throw new RangeError("Sample copy steps must contain a bounded positive sample count.");
  }
  return length;
}

export function allocateSampleCopy(length: number, typed: boolean): SampleBuffer {
  if (!Number.isInteger(length) || length < 3 || length > MAX_SAMPLE_VALUES) {
    throw new RangeError("Sample copy allocation exceeds the supported buffer range.");
  }
  return typed ? new Float64Array(length) : new Array<number>(length);
}

/** Each external value is read once, without numeric conversion or canonicalization. */
export function copySampleRange(
  source: SampleSource,
  target: SampleBuffer,
  start: number,
  end: number,
  proof?: SampleCopyProof,
): void {
  for (let index = start; index < end; index += 1) {
    const descriptor = assertSampleDescriptor(source, index);
    const value = source[index];
    if (typeof value !== "number") throw new TypeError("Stroke samples must contain numbers.");
    target[index] = value;
    if (proof?.eligible && !immutableDataDescriptor(descriptor, value)) proof.eligible = false;
  }
}

/** Returns the first differing value without reading that external value again. */
export function compareSampleRange(
  source: SampleSource,
  expected: SampleSource,
  start: number,
  end: number,
): { index: number; value: number } | undefined {
  for (let index = start; index < end; index += 1) {
    assertSampleDescriptor(source, index);
    const value = source[index];
    if (typeof value !== "number") throw new TypeError("Stroke samples must contain numbers.");
    if (!Object.is(value, expected[index])) return { index, value };
  }
  return undefined;
}

function assertSampleDescriptor(
  source: SampleSource,
  index: number,
): PropertyDescriptor | undefined {
  if (!Array.isArray(source)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError("Stroke sample arrays must contain dense enumerable data values.");
  }
  return descriptor;
}

function immutableDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
  value: number,
): boolean {
  return (
    descriptor !== undefined &&
    descriptor.writable === false &&
    descriptor.configurable === false &&
    Object.is(descriptor.value, value)
  );
}

/** Numeric entries are inspected by the copy ranges; this bounded walk rejects extra keys. */
export function* assertSampleArrayKeysSteps(
  source: SampleSource,
  valuesPerStep: number,
): Generator<void, void> {
  if (!Array.isArray(source)) return;
  if (Object.getOwnPropertySymbols(source).length > 0)
    throw new TypeError("Stroke sample arrays must not contain symbols.");
  let entries = 0;
  // eslint-disable-next-line @typescript-eslint/no-for-in-array -- Inspect hostile extra keys without an unbounded allocated key list.
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= source.length) {
      throw new TypeError("Stroke sample arrays must contain indexed values only.");
    }
    entries += 1;
    if (entries % valuesPerStep === 0) yield;
  }
}
