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
  for (let start = 0; start < length; start += valuesPerStep) {
    copySampleRange(points, candidate, start, Math.min(length, start + valuesPerStep), proof);
    yield;
  }
  yield* assertSampleArrayKeysSteps(points, valuesPerStep);
  finishSampleCopyProof(proof);
  if (representation === "immutable-json") {
    Object.freeze(candidate);
    if (proof.finite) capturedJsonSamples.add(candidate);
  }
  return candidate;
}
