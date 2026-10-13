import {
  allocateSampleCopy,
  assertSampleCopyInput,
  assertSampleArrayKeysSteps,
  copySampleRange,
  createSampleCopyProof,
  DEFAULT_SAMPLE_COPY_STEP,
  finishSampleCopyProof,
  type SampleBuffer,
  type SampleSource,
} from "./runtime-sample-copy";

const capturedJsonSamples = new WeakSet<object>();

/** Only this producer registers frozen, dense finite numeric JSON sample arrays. */
export function isCapturedJsonSampleArray(points: object): boolean {
  return capturedJsonSamples.has(points);
}

/** Private producer provenance permits scalar copying without another structural inspection. */
function copyCapturedJsonSampleRange(
  source: SampleSource,
  target: SampleBuffer,
  start: number,
  end: number,
): void {
  for (let index = start; index < end; index += 1) target[index] = source[index]!;
}

export function copyImmutableJsonSampleSteps(points: SampleSource): Generator<void, number[]> {
  const length = assertSampleCopyInput(points, DEFAULT_SAMPLE_COPY_STEP);
  return produceSampleBufferSteps(
    points,
    length,
    DEFAULT_SAMPLE_COPY_STEP * 3,
    "immutable-json",
  ) as Generator<void, number[]>;
}

export function copySampleBufferSteps(
  points: SampleSource,
  length: number,
  valuesPerStep: number,
  representation: "json" | "runtime",
): Generator<void, SampleBuffer> {
  const capturedLength = assertSampleCopyInput(points, valuesPerStep / 3);
  if (length !== capturedLength) {
    throw new RangeError("Sample copy length must match the captured source length.");
  }
  if (representation !== "json" && representation !== "runtime") {
    throw new TypeError("Sample copies must use a supported buffer representation.");
  }
  return produceSampleBufferSteps(points, length, valuesPerStep, representation);
}

function* produceSampleBufferSteps(
  points: SampleSource,
  length: number,
  valuesPerStep: number,
  representation: "json" | "runtime" | "immutable-json",
): Generator<void, SampleBuffer> {
  const candidate = allocateSampleCopy(length, representation === "runtime");
  const proof = createSampleCopyProof(points);
  const captured = capturedJsonSamples.has(points);
  for (let start = 0; start < length; start += valuesPerStep) {
    const end = Math.min(length, start + valuesPerStep);
    if (captured) copyCapturedJsonSampleRange(points, candidate, start, end);
    else copySampleRange(points, candidate, start, end, proof);
    yield;
  }
  if (!captured) yield* assertSampleArrayKeysSteps(points, valuesPerStep);
  finishSampleCopyProof(proof);
  if (representation === "immutable-json") {
    Object.freeze(candidate);
    if (proof.finite) capturedJsonSamples.add(candidate);
  }
  return candidate;
}
