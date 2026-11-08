import { FILE_SCHEMA_LIMITS, MAX_STROKE_POINTS } from "../../../../domain/schema/constants";
import {
  isNativeArrayBuffer,
  isNativeFloat64Array,
  isNativeUint32Array,
} from "../../../serialization/transfer-array";
import { documentElementWireLimitSteps } from "./packed-element-wire-limits";
import type { PackedElements } from "./element-wire-codec";

/** Limits native transfer-list fanout, independently of cooperative CPU admission. */
export const MODEL_SYNC_POINT_BUFFER_TRANSFER_LIMIT = 128;
const MAX_POINT_VALUES = FILE_SCHEMA_LIMITS.strokePoints * 3;
const COPY_VALUES_PER_STEP = 8 * 1024;
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype)!;
const viewBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!;
const viewOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!;
const viewBytes = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!;
const viewLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "length")!;
const bufferBytes = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!;

export interface ModelSyncPointArenaEnvelope {
  readonly format: "point-arena";
  readonly pointArena: Float64Array;
  readonly pointLengths: Uint32Array;
  readonly records: PackedElements["records"];
}

export type PackedModelSyncElements = PackedElements | ModelSyncPointArenaEnvelope;

/** Captured element headers and reference indices stay unchanged; only new point copies move. */
export function* prepareModelSyncPointArenaSteps(
  packed: PackedElements,
): Generator<void, PackedModelSyncElements> {
  if (packed.pointBuffers.length <= MODEL_SYNC_POINT_BUFFER_TRANSFER_LIMIT) return packed;
  yield* documentElementWireLimitSteps(packed);
  const pointLengths = new Uint32Array(packed.pointBuffers.length);
  let length = 0;
  for (let index = 0; index < pointLengths.length; index += 1) {
    const span = exclusiveSpan(packed.pointBuffers[index]!);
    pointLengths[index] = span.length;
    length += span.length;
    if (length > MAX_POINT_VALUES)
      throw new RangeError("Model synchronization arena exceeds the point-buffer byte limit.");
    if ((index + 1) % 64 === 0) yield;
  }
  const pointArena = new Float64Array(length);
  let offset = 0;
  for (let index = 0; index < pointLengths.length; index += 1) {
    const span = exclusiveSpan(packed.pointBuffers[index]!);
    yield* copyValuesSteps(new Float64Array(span.buffer, 0, span.length), pointArena, offset);
    offset += span.length;
    if ((index + 1) % 64 === 0) yield;
  }
  return { format: "point-arena", pointArena, pointLengths, records: packed.records };
}

/** Private full-span stroke buffers prevent one retained stroke from keeping the arena alive. */
export function* expandModelSyncPointArenaSteps(
  input: PackedModelSyncElements,
): Generator<void, PackedElements> {
  if (typeof input !== "object" || input === null)
    throw new TypeError("Model synchronization elements must use a wire envelope.");
  if (!("format" in input)) return input;
  const { format, pointArena, pointLengths, records } = input;
  if (format !== "point-arena" || !Array.isArray(records))
    throw new TypeError("Model synchronization point arena is invalid.");
  if (!isNativeFloat64Array(pointArena) || !isNativeUint32Array(pointLengths))
    throw new TypeError("Model synchronization arena arrays must use native wire brands.");
  const arena = exclusiveSpan(pointArena);
  const lengths = exclusiveSpan(pointLengths);
  if (arena.buffer === lengths.buffer)
    throw new TypeError("Model synchronization arena arrays must have separate backing stores.");
  if (
    records.length > FILE_SCHEMA_LIMITS.elements ||
    lengths.length > records.length ||
    arena.length > MAX_POINT_VALUES
  )
    throw new RangeError("Model synchronization arena exceeds document transfer limits.");
  const capturedLengths = new Uint32Array(new Uint32Array(lengths.buffer, 0, lengths.length));
  yield* validateLengthsSteps(capturedLengths, arena.length);
  const source = new Float64Array(arena.buffer, 0, arena.length);
  const pointBuffers: Float64Array[] = [];
  let offset = 0;
  for (let index = 0; index < capturedLengths.length; index += 1) {
    const length = capturedLengths[index]!;
    const points = new Float64Array(length);
    yield* copyValuesSteps(source.subarray(offset, offset + length), points);
    pointBuffers.push(points);
    offset += length;
    if ((index + 1) % 64 === 0) yield;
  }
  return { records, pointBuffers };
}

function* validateLengthsSteps(lengths: Uint32Array, expected: number): Generator<void> {
  let total = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (length < 3 || length % 3 !== 0 || length > MAX_STROKE_POINTS * 3)
      throw new RangeError("Model synchronization arena stroke length is invalid.");
    total += length;
    if (total > MAX_POINT_VALUES)
      throw new RangeError("Model synchronization arena exceeds the point-buffer byte limit.");
    if ((index + 1) % 64 === 0) yield;
  }
  if (total !== expected)
    throw new RangeError("Model synchronization arena lengths do not consume its exact span.");
}

function exclusiveSpan(value: Float64Array | Uint32Array): { buffer: ArrayBuffer; length: number } {
  const buffer = viewBuffer.get!.call(value) as unknown;
  if (!isNativeArrayBuffer(buffer))
    throw new TypeError("Model synchronization arena must use ordinary ArrayBuffer storage.");
  if (
    viewOffset.get!.call(value) !== 0 ||
    viewBytes.get!.call(value) !== bufferBytes.get!.call(buffer)
  )
    throw new TypeError("Model synchronization arena arrays must exclusively own their full span.");
  return { buffer, length: viewLength.get!.call(value) as number };
}

function* copyValuesSteps(source: Float64Array, target: Float64Array, offset = 0): Generator<void> {
  for (let start = 0; start < source.length; start += COPY_VALUES_PER_STEP) {
    const end = Math.min(source.length, start + COPY_VALUES_PER_STEP);
    target.set(source.subarray(start, end), offset + start);
    if (end < source.length) yield;
  }
}
