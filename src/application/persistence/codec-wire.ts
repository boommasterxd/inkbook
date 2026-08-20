import { SCENE_RESOURCE_LIMITS_V1 } from "../../domain/codecs";
import { parseElementId } from "../../domain/model";
import {
  SIDECAR_RESOURCE_LIMITS_V1,
  SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1,
} from "./codec";
import {
  createPersistenceChunkPlanV1,
  createPersistenceEncodeWorkV1,
  createPersistenceParseWorkV1,
  PERSISTENCE_CODEC_WIRE_VERSION_V1,
  PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1,
  type PersistenceChunkRangeV1,
  type PersistenceCodecWorkResultV1,
  type PersistenceCodecWorkV1,
} from "./codec-work";
import type { SidecarDecodeResultV1 } from "./types";
import {
  validateInkbookSidecarV1,
  validateSidecarVersionStructure,
} from "./validation";

export function normalizePersistenceCodecWorkV1(
  value: unknown,
): PersistenceCodecWorkV1 {
  const work = readRecord(value, "Persistence codec work");
  assertWireVersion(work.wireVersion);
  if (work.kind === "parse-sidecar") return normalizeParseWork(work);
  if (work.kind !== "encode-sidecar") {
    throw new TypeError("Persistence codec work kind is unsupported.");
  }
  return normalizeEncodeWork(work);
}

export function normalizePersistenceCodecWorkResultV1(
  value: unknown,
): PersistenceCodecWorkResultV1 {
  const result = readRecord(value, "Persistence codec result");
  assertWireVersion(result.wireVersion);
  if (result.kind === "parsed-sidecar") {
    return Object.freeze({
      wireVersion: PERSISTENCE_CODEC_WIRE_VERSION_V1,
      kind: "parsed-sidecar",
      value: normalizeDecodedResult(result.value),
    });
  }
  if (result.kind !== "encoded-sidecar") {
    throw new TypeError("Persistence codec result kind is unsupported.");
  }
  return normalizeEncodedResult(result);
}

function normalizeParseWork(
  work: Record<string, unknown>,
): PersistenceCodecWorkV1 {
  if (typeof work.rawText !== "string") {
    throw new TypeError("Persistence parse work requires raw text.");
  }
  return createPersistenceParseWorkV1(
    work.rawText,
    readNumber(work.admittedUtf8Bytes, "Admitted UTF-8 bytes"),
    readNumber(work.admittedDecodedBytes, "Admitted decoded bytes"),
  );
}

function normalizeEncodeWork(
  work: Record<string, unknown>,
): PersistenceCodecWorkV1 {
  const decodedBytes = readNumber(
    work.admittedDecodedBytes,
    "Admitted decoded bytes",
  );
  assertPositiveBounded(
    decodedBytes,
    PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1,
    "Admitted decoded bytes",
  );
  if (work.writableTier !== "phone" && work.writableTier !== "desktop-tablet") {
    throw new TypeError("Persistence encode writable tier is invalid.");
  }
  const affected = readArray(work.affectedElementIds, "Affected element IDs");
  if (affected.length > SCENE_RESOURCE_LIMITS_V1.maxRecords) {
    throw new RangeError("Persistence affected element IDs exceed the limit.");
  }
  const affectedElementIds = affected.map((value) => {
    if (typeof value !== "string") throw new TypeError("Invalid element ID.");
    return parseElementId(value);
  });
  const admittedInputBytes = readNumber(
    work.admittedInputBytes,
    "Admitted input bytes",
  );
  assertPositiveBounded(
    admittedInputBytes,
    SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1[work.writableTier],
    "Admitted input bytes",
  );
  return createPersistenceEncodeWorkV1(
    work.sidecar as Parameters<typeof createPersistenceEncodeWorkV1>[0],
    work.writableTier,
    decodedBytes,
    admittedInputBytes,
    affectedElementIds,
  );
}

function normalizeEncodedResult(
  result: Record<string, unknown>,
): PersistenceCodecWorkResultV1 {
  const bytes = readCompleteBytes(result.bytes, "Encoded sidecar bytes");
  if (bytes.byteLength > SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1["desktop-tablet"]) {
    throw new RangeError("Encoded sidecar result exceeds the V1 limit.");
  }
  const byteChunks = normalizeChunkPlan(result.byteChunks, bytes.byteLength);
  const elementCount = readCount(result.elementCount);
  if (elementCount > SCENE_RESOURCE_LIMITS_V1.maxRecords) {
    throw new RangeError("Encoded element count exceeds the record limit.");
  }
  const encodedElementCount = readCount(result.encodedElementCount);
  const reusedElementCount = readCount(result.reusedElementCount);
  if (encodedElementCount + reusedElementCount !== elementCount) {
    throw new RangeError("Encoded element chunk counts are inconsistent.");
  }
  return Object.freeze({
    wireVersion: PERSISTENCE_CODEC_WIRE_VERSION_V1,
    kind: "encoded-sidecar",
    bytes,
    byteChunks,
    elementCount,
    encodedElementCount,
    reusedElementCount,
  });
}

function normalizeDecodedResult(value: unknown): SidecarDecodeResultV1 {
  const result = readRecord(value, "Decoded sidecar result");
  if (result.kind === "current") {
    return Object.freeze({
      kind: "current",
      sidecar: validateInkbookSidecarV1(result.sidecar),
    });
  }
  if (result.kind !== "read-only-newer-version") {
    throw new TypeError("Decoded sidecar result kind is unsupported.");
  }
  return Object.freeze({
    kind: "read-only-newer-version",
    schemaVersion: validateSidecarVersionStructure(result.schemaVersion),
  });
}

function normalizeChunkPlan(
  value: unknown,
  byteLength: number,
): readonly PersistenceChunkRangeV1[] {
  const supplied = readArray(value, "Encoded byte chunks");
  const expected = createPersistenceChunkPlanV1(
    byteLength,
    SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes,
  );
  if (supplied.length !== expected.length)
    throw new RangeError("Invalid byte chunk plan.");
  supplied.forEach((candidate, index) => {
    const record = readRecord(candidate, "Encoded byte chunk");
    const expectedChunk = expected[index];
    if (
      record.offset !== expectedChunk?.offset ||
      record.length !== expectedChunk?.length
    ) {
      throw new RangeError("Invalid byte chunk plan.");
    }
  });
  return expected;
}

function readCompleteBytes(
  value: unknown,
  name: string,
): Uint8Array<ArrayBuffer> {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.byteOffset !== 0 ||
    value.byteLength !== value.buffer.byteLength
  ) {
    throw new TypeError(`${name} must own one complete ArrayBuffer.`);
  }
  return value as Uint8Array<ArrayBuffer>;
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a record.`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  return value;
}

function readNumber(value: unknown, name: string): number {
  if (typeof value !== "number")
    throw new TypeError(`${name} must be numeric.`);
  return value;
}

function readCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError("Persistence result count must be non-negative.");
  }
  return value as number;
}

function assertWireVersion(value: unknown): void {
  if (value !== PERSISTENCE_CODEC_WIRE_VERSION_V1) {
    throw new TypeError("Persistence codec wire version is unsupported.");
  }
}

function assertPositiveBounded(
  value: number,
  maximum: number,
  name: string,
): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} is outside its bounded range.`);
  }
}
