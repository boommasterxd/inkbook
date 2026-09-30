import {
  isCanonicalGeometryNumber,
  isCanonicalUnitIntervalNumber,
} from "../../domain/schema/canonical";
import { MAX_ABSOLUTE_COORDINATE, MAX_STROKE_POINTS } from "../../domain/schema/constants";
import { SampleBase64Reader, SampleBase64Writer } from "./sample-base64";

const GEOMETRY_SCALE = 1000;
const PRESSURE_SCALE = 10000;
const MAXIMUM_SCALED_COORDINATE = MAX_ABSOLUTE_COORDINATE * GEOMETRY_SCALE;
const MAXIMUM_POINT_BYTES = 12;
const CANCELLATION_INTERVAL_POINTS = 256;
const MAXIMUM_ENCODED_CHARACTERS = Math.ceil((MAX_STROKE_POINTS * MAXIMUM_POINT_BYTES + 3) / 3) * 4;

export const COMPACT_METADATA_ENCODING = "json-varint-v1";
export type SnapshotMetadataEncoding = "json" | typeof COMPACT_METADATA_ENCODING;

/** Point count, then ZigZag coordinate deltas and unsigned pressure, encoded as canonical LEB128. */
export function encodeStrokeSamples(points: ArrayLike<number>): string {
  return completeSteps(encodeStrokeSamplesSteps(points));
}

export function* encodeStrokeSamplesSteps(
  points: ArrayLike<number>,
  signal?: AbortSignal,
): Generator<void, string> {
  signal?.throwIfAborted();
  const count = points.length / 3;
  assertPointCount(count);
  const writer = new SampleBase64Writer();
  appendVarint(writer, count);
  let previousX = 0;
  let previousY = 0;
  for (let point = 0; point < count; point += 1) {
    const x = scaledCoordinate(points[point * 3]);
    const y = scaledCoordinate(points[point * 3 + 1]);
    const pressure = points[point * 3 + 2];
    if (!isCanonicalUnitIntervalNumber(pressure)) invalidSamples();
    appendVarint(writer, zigZag(x - previousX));
    appendVarint(writer, zigZag(y - previousY));
    appendVarint(writer, Math.round(pressure * PRESSURE_SCALE));
    previousX = x;
    previousY = y;
    if ((point + 1) % CANCELLATION_INTERVAL_POINTS === 0) {
      signal?.throwIfAborted();
      yield;
    }
  }
  signal?.throwIfAborted();
  return writer.finish();
}

/** Each bounded step may checkpoint through the caller's central WorkScheduler. */
export function* decodeStrokeSamplesSteps(
  input: string,
  signal?: AbortSignal,
  maximumPoints: number = MAX_STROKE_POINTS,
): Generator<void, Float64Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  if (typeof input !== "string" || input.length > MAXIMUM_ENCODED_CHARACTERS) invalidSamples();
  const reader = new SampleBase64Reader(input);
  const count = readVarint(reader);
  assertPointCount(count);
  if (!Number.isSafeInteger(maximumPoints) || maximumPoints < count) invalidSamples();
  if (reader.remainingBytes < count * 3 || reader.remainingBytes > count * MAXIMUM_POINT_BYTES) {
    invalidSamples();
  }
  const points = new Float64Array(count * 3);
  let x = 0;
  let y = 0;
  for (let point = 0; point < count; point += 1) {
    x += unZigZag(readVarint(reader));
    y += unZigZag(readVarint(reader));
    const pressure = readVarint(reader);
    if (
      Math.abs(x) > MAXIMUM_SCALED_COORDINATE ||
      Math.abs(y) > MAXIMUM_SCALED_COORDINATE ||
      pressure > PRESSURE_SCALE
    ) {
      invalidSamples();
    }
    points[point * 3] = x / GEOMETRY_SCALE;
    points[point * 3 + 1] = y / GEOMETRY_SCALE;
    points[point * 3 + 2] = pressure / PRESSURE_SCALE;
    if ((point + 1) % CANCELLATION_INTERVAL_POINTS === 0) {
      signal?.throwIfAborted();
      yield;
    }
  }
  if (reader.remainingBytes !== 0) invalidSamples();
  signal?.throwIfAborted();
  return points;
}

function scaledCoordinate(value: number | undefined): number {
  if (!isCanonicalGeometryNumber(value) || Math.abs(value) > MAX_ABSOLUTE_COORDINATE) {
    invalidSamples();
  }
  return Math.round(value * GEOMETRY_SCALE);
}

function assertPointCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_STROKE_POINTS) invalidSamples();
}

function zigZag(value: number): number {
  return value < 0 ? -value * 2 - 1 : value * 2;
}

function unZigZag(value: number): number {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

function appendVarint(writer: SampleBase64Writer, value: number): void {
  while (value >= 128) {
    writer.append((value % 128) + 128);
    value = Math.floor(value / 128);
  }
  writer.append(value);
}

function readVarint(reader: SampleBase64Reader): number {
  let value = 0;
  let scale = 1;
  for (let index = 0; index < 5; index += 1) {
    const byte = reader.read();
    value += (byte & 127) * scale;
    if (value > 4_000_000_000) invalidSamples();
    if (byte < 128) {
      if (index > 0 && byte === 0) invalidSamples();
      return value;
    }
    scale *= 128;
  }
  return invalidSamples();
}

function completeSteps<T>(steps: Generator<void, T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

function invalidSamples(): never {
  throw new RangeError("Invalid compact stroke samples.");
}
