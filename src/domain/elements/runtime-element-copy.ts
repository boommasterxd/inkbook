import { MAX_JSON_DEPTH } from "../schema/constants";
import { hasPlainJsonRecordPrototype } from "../schema/validation-internals";
import {
  allocateSampleCopy,
  assertSampleCopyInput,
  compareSampleRange,
  copySampleRange,
  assertSampleArrayKeysSteps,
  DEFAULT_SAMPLE_COPY_STEP,
  type SampleBuffer,
  type SampleSource,
} from "./runtime-sample-copy";
import {
  copySampleBufferSteps,
  copyImmutableJsonSampleSteps,
} from "./runtime-sample-copy-producer";

const MAX_HEADER_NODES = 256;
const immutableCapturedHeaders = new WeakSet<object>();

interface HeaderCopyBudget {
  remaining: number;
  readonly ancestors: Set<object>;
}

/** Stroke protocol fields are removed only after every header descriptor is captured safely. */
export function captureImmutableRuntimeElementHeader(
  element: object,
  excludedStrokeKeys?: ReadonlySet<string>,
): Record<string, unknown> {
  const captured = captureRuntimeElementHeader(element);
  const header =
    captured.kind === "stroke" && excludedStrokeKeys !== undefined
      ? Object.fromEntries(Object.entries(captured).filter(([key]) => !excludedStrokeKeys.has(key)))
      : captured;
  if (freezeCapturedHeader(header)) immutableCapturedHeaders.add(header);
  return header;
}

/** Only header ownership is reused; the attached samples remain untrusted input. */
export function attachCapturedStrokeSamples(
  header: Record<string, unknown>,
  points: SampleSource,
): Record<string, unknown> {
  if (!immutableCapturedHeaders.has(header)) {
    throw new TypeError("Stroke samples require a privately captured immutable header.");
  }
  const element = Object.freeze({ ...header, points });
  immutableCapturedHeaders.add(element);
  return element;
}

export function preparedInsertionHeader(element: object): Record<string, unknown> | undefined {
  if (!immutableCapturedHeaders.has(element)) return undefined;
  const header = element as Record<string, unknown>;
  if (header.kind !== "stroke") return header;
  const { points: _points, ...fields } = header;
  return fields;
}

function freezeCapturedHeader(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (value instanceof Float64Array) return false;
  let immutable = true;
  for (const child of Object.values(value)) {
    immutable = freezeCapturedHeader(child) && immutable;
  }
  Object.freeze(value);
  return immutable;
}

/** Capture all fields, including invalid unknown fields, before sample work can yield. */
export function captureRuntimeElementHeader(
  element: object,
  excludedKeys?: ReadonlySet<string>,
): Record<string, unknown> {
  const budget: HeaderCopyBudget = { remaining: MAX_HEADER_NODES, ancestors: new Set() };
  assertHeaderRecord(element);
  const header: Record<string, unknown> = {};
  const stroke = headerProperty(element, "kind") === "stroke";
  budget.ancestors.add(element);
  for (const key of boundedHeaderKeys(element, budget.remaining)) {
    const value = headerProperty(element, key);
    if ((stroke && key === "points") || excludedKeys?.has(key)) continue;
    const child = cloneHeaderValue(value, budget, 2);
    Object.defineProperty(header, key, { value: child, enumerable: true, writable: true });
  }
  return header;
}

function cloneHeaderValue(value: unknown, budget: HeaderCopyBudget, depth: number): unknown {
  budget.remaining -= 1;
  if (budget.remaining < 0 || depth > MAX_JSON_DEPTH) {
    throw new RangeError("Runtime element header exceeds the bounded copy limit.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (typeof value !== "object")
    throw new TypeError("Runtime element headers must contain JSON data.");
  if (budget.ancestors.has(value)) throw new TypeError("Runtime element headers must be acyclic.");
  budget.ancestors.add(value);
  const clone = cloneHeaderObject(value, budget, depth);
  budget.ancestors.delete(value);
  return clone;
}

function cloneHeaderObject(value: object, budget: HeaderCopyBudget, depth: number): unknown {
  if (Array.isArray(value) || value instanceof Float64Array) {
    if (value.length > budget.remaining) {
      throw new RangeError("Runtime element header array exceeds the bounded copy limit.");
    }
    if (Array.isArray(value)) assertHeaderArray(value);
    const clone: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const child =
        value instanceof Float64Array ? value[index] : headerProperty(value, String(index));
      clone.push(cloneHeaderValue(child, budget, depth + 1));
    }
    return value instanceof Float64Array ? new Float64Array(clone as number[]) : clone;
  }
  assertHeaderRecord(value);
  const clone: Record<string, unknown> = {};
  for (const key of boundedHeaderKeys(value, budget.remaining)) {
    const child = cloneHeaderValue(headerProperty(value, key), budget, depth + 1);
    Object.defineProperty(clone, key, { value: child, enumerable: true, writable: true });
  }
  return clone;
}

function assertHeaderRecord(value: object): void {
  if (!hasPlainJsonRecordPrototype(value)) {
    throw new TypeError("Runtime element headers must use plain JSON object prototypes.");
  }
}

function boundedHeaderKeys(value: object, maximum: number): string[] {
  let entries = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    entries += 1;
    if (entries > maximum)
      throw new RangeError("Runtime element header exceeds the bounded copy limit.");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Runtime element headers must not contain symbol properties.");
  }
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > maximum)
    throw new RangeError("Runtime element header exceeds the bounded copy limit.");
  return keys;
}

function headerProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError("Runtime element header properties must be enumerable data values.");
  }
  return descriptor.value;
}

function assertHeaderArray(value: unknown[]): void {
  const keys = boundedHeaderKeys(value, value.length + 1);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw new TypeError("Runtime element header arrays must contain dense indexed values only.");
  }
  for (const key of keys) {
    if (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) {
      throw new TypeError("Runtime element header arrays must contain indexed values only.");
    }
  }
}

export function copyStrokeSamplesToRuntimeSteps(
  points: SampleSource,
  samplesPerStep = DEFAULT_SAMPLE_COPY_STEP,
): Generator<void, Float64Array> {
  const length = assertSampleCopyInput(points, samplesPerStep);
  return copySampleBufferSteps(points, length, samplesPerStep * 3, "runtime") as Generator<
    void,
    Float64Array
  >;
}

/** The result has no mutable aliases and carries private JSON-tree preparation proof. */
export function copyStrokeSamplesToImmutableJsonSteps(
  points: SampleSource,
): Generator<void, number[]> {
  return copyImmutableJsonSampleSteps(points);
}

/** The expected buffer must be exclusively owned and immutable throughout consumption. */
export function stageStrokeSamplesSteps(
  points: SampleSource,
  expected?: SampleSource,
  samplesPerStep = DEFAULT_SAMPLE_COPY_STEP,
): Generator<void, SampleSource> {
  const length = assertSampleCopyInput(points, samplesPerStep);
  if (points === expected) return returnOwnedSamples(points);
  if (
    expected?.length !== length ||
    points instanceof Float64Array !== expected instanceof Float64Array
  ) {
    return copySampleBufferSteps(
      points,
      length,
      samplesPerStep * 3,
      points instanceof Float64Array ? "runtime" : "json",
    );
  }
  return compareAndStageSamples(points, expected, samplesPerStep * 3);
}

function* returnOwnedSamples(points: SampleSource): Generator<void, SampleSource> {
  yield* [];
  return points;
}

function* compareAndStageSamples(
  points: SampleSource,
  expected: SampleSource,
  valuesPerStep: number,
): Generator<void, SampleSource> {
  const length = expected.length;
  for (let start = 0; start < length; start += valuesPerStep) {
    const end = Math.min(length, start + valuesPerStep);
    const difference = compareSampleRange(points, expected, start, end);
    if (difference !== undefined) {
      return yield* stageDifferentSamples(points, expected, difference, valuesPerStep);
    }
    yield;
  }
  yield* assertSampleArrayKeysSteps(points, valuesPerStep);
  return expected;
}

function* stageDifferentSamples(
  points: SampleSource,
  expected: SampleSource,
  difference: { index: number; value: number },
  valuesPerStep: number,
): Generator<void, SampleBuffer> {
  const length = expected.length;
  const candidate = allocateSampleCopy(length, points instanceof Float64Array);
  candidate[difference.index] = difference.value;
  for (let start = 0; start < difference.index; start += valuesPerStep) {
    copySampleRange(expected, candidate, start, Math.min(difference.index, start + valuesPerStep));
    yield;
  }
  for (let start = difference.index + 1; start < length; start += valuesPerStep) {
    copySampleRange(points, candidate, start, Math.min(length, start + valuesPerStep));
    yield;
  }
  yield* assertSampleArrayKeysSteps(points, valuesPerStep);
  return candidate;
}

/** The source header and point reference are captured when called, before the first next(). */
export function copyRuntimeElementSteps<T extends object>(
  element: T,
  ownedPoints?: SampleSource,
): Generator<void, T> {
  const header = captureRuntimeElementHeader(element);
  if (header.kind !== "stroke") return returnHeader<T>(header);
  const points = headerProperty(element, "points") as SampleSource;
  return finishStrokeHeader<T>(header, stageStrokeSamplesSteps(points, ownedPoints));
}

function* returnHeader<T extends object>(header: Record<string, unknown>): Generator<void, T> {
  yield* [];
  return header as T;
}

function* finishStrokeHeader<T extends object>(
  header: Record<string, unknown>,
  samples: Generator<void, SampleSource>,
): Generator<void, T> {
  header.points = yield* samples;
  return header as T;
}
