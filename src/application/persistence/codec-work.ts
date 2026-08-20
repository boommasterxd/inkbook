import {
  SIDECAR_RESOURCE_LIMITS_V1,
  SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1,
} from "./codec";
import type { ElementId } from "../../domain/model";
import type {
  InkbookSidecarV1,
  SidecarDecodeResultV1,
  SidecarWritableTierV1,
} from "./types";

export const PERSISTENCE_CODEC_WIRE_VERSION_V1 = 1 as const;
export const PERSISTENCE_CODEC_CHUNK_UNITS_V1 = 16_384;
const MEBIBYTE = 1_048_576;
export const PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1 = Number("128") * MEBIBYTE;

export interface PersistenceChunkRangeV1 {
  readonly offset: number;
  readonly length: number;
}

export interface PersistenceEncodeWorkV1 {
  readonly wireVersion: typeof PERSISTENCE_CODEC_WIRE_VERSION_V1;
  readonly kind: "encode-sidecar";
  readonly sidecar: InkbookSidecarV1;
  readonly writableTier: SidecarWritableTierV1;
  /** Conservative structured-clone bytes reserved before scheduler admission. */
  readonly admittedInputBytes: number;
  readonly admittedDecodedBytes: number;
  readonly affectedElementIds: readonly ElementId[];
}

export interface PersistenceParseWorkV1 {
  readonly wireVersion: typeof PERSISTENCE_CODEC_WIRE_VERSION_V1;
  readonly kind: "parse-sidecar";
  readonly rawText: string;
  readonly admittedUtf8Bytes: number;
  readonly admittedDecodedBytes: number;
  readonly textChunks: readonly PersistenceChunkRangeV1[];
}

export type PersistenceCodecWorkV1 =
  PersistenceEncodeWorkV1 | PersistenceParseWorkV1;

export interface PersistenceEncodedWorkResultV1 {
  readonly wireVersion: typeof PERSISTENCE_CODEC_WIRE_VERSION_V1;
  readonly kind: "encoded-sidecar";
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly byteChunks: readonly PersistenceChunkRangeV1[];
  readonly elementCount: number;
  readonly encodedElementCount: number;
  readonly reusedElementCount: number;
}

interface PersistenceParsedWorkResultV1 {
  readonly wireVersion: typeof PERSISTENCE_CODEC_WIRE_VERSION_V1;
  readonly kind: "parsed-sidecar";
  readonly value: SidecarDecodeResultV1;
}

export type PersistenceCodecWorkResultV1 =
  PersistenceEncodedWorkResultV1 | PersistenceParsedWorkResultV1;

export interface PersistenceCodecSubmissionV1 {
  readonly result: Promise<PersistenceCodecWorkResultV1>;
  cancel(): void;
}

export interface PersistenceCodecPortV1 {
  submit(work: PersistenceCodecWorkV1): PersistenceCodecSubmissionV1;
}

export interface PersistenceDecodedByteOwnerV1 {
  readonly byteLength: number;
  readonly released: boolean;
  release(): void;
}

export class PersistenceDecodedBytePoolV1 {
  readonly #maximumBytes: number;
  #ownedBytes = 0;

  constructor(maximumBytes = PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1) {
    assertBoundedSize(
      maximumBytes,
      PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1,
      "Decoded memory pool",
    );
    if (maximumBytes === 0) {
      throw new RangeError("Decoded memory pool must have positive capacity.");
    }
    this.#maximumBytes = maximumBytes;
  }

  get ownedBytes(): number {
    return this.#ownedBytes;
  }

  tryAcquire(byteLength: number): PersistenceDecodedByteOwnerV1 | null {
    assertDecodedSize(byteLength);
    if (byteLength > this.#maximumBytes - this.#ownedBytes) return null;
    this.#ownedBytes += byteLength;
    let released = false;
    return Object.freeze({
      byteLength,
      get released(): boolean {
        return released;
      },
      release: (): void => {
        if (released) return;
        released = true;
        this.#ownedBytes -= byteLength;
      },
    });
  }
}

export function createPersistenceChunkPlanV1(
  totalUnits: number,
  maximumUnits: number,
): readonly PersistenceChunkRangeV1[] {
  assertBoundedSize(totalUnits, maximumUnits, "Persistence payload");
  const chunks: PersistenceChunkRangeV1[] = [];
  for (
    let offset = 0;
    offset < totalUnits;
    offset += PERSISTENCE_CODEC_CHUNK_UNITS_V1
  ) {
    chunks.push(
      Object.freeze({
        offset,
        length: Math.min(PERSISTENCE_CODEC_CHUNK_UNITS_V1, totalUnits - offset),
      }),
    );
  }
  return Object.freeze(chunks);
}

export function createPersistenceParseWorkV1(
  rawText: string,
  admittedUtf8Bytes: number,
  decodedBytes: PersistenceDecodedByteOwnerV1 | number,
): PersistenceParseWorkV1 {
  assertBoundedSize(
    admittedUtf8Bytes,
    SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes,
    "Sidecar input",
  );
  const admittedDecodedBytes = readDecodedAdmission(decodedBytes);
  if (rawText.length > SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes) {
    throw new RangeError("Sidecar text exceeds the bounded parser admission.");
  }
  return Object.freeze({
    wireVersion: PERSISTENCE_CODEC_WIRE_VERSION_V1,
    kind: "parse-sidecar",
    rawText,
    admittedUtf8Bytes,
    admittedDecodedBytes,
    textChunks: createPersistenceChunkPlanV1(
      rawText.length,
      SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes,
    ),
  });
}

export function createPersistenceEncodeWorkV1(
  sidecar: InkbookSidecarV1,
  writableTier: SidecarWritableTierV1,
  decodedBytes: PersistenceDecodedByteOwnerV1 | number,
  admittedInputBytes: number,
  affectedElementIds: readonly ElementId[] = Object.freeze([]),
): PersistenceEncodeWorkV1 {
  const admittedDecodedBytes = readDecodedAdmission(decodedBytes);
  assertBoundedSize(
    admittedInputBytes,
    SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1[writableTier],
    "Persistence encode input",
  );
  if (admittedInputBytes === 0) {
    throw new RangeError(
      "Persistence encode input admission must be positive.",
    );
  }
  return Object.freeze({
    wireVersion: PERSISTENCE_CODEC_WIRE_VERSION_V1,
    kind: "encode-sidecar",
    sidecar,
    writableTier,
    admittedInputBytes,
    admittedDecodedBytes,
    affectedElementIds: Object.freeze([...affectedElementIds]),
  });
}

function assertBoundedSize(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} size is outside its bounded range.`);
  }
}

function assertDecodedSize(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1
  ) {
    throw new RangeError("Decoded memory size is outside its bounded range.");
  }
}

function assertActiveDecodedOwner(owner: PersistenceDecodedByteOwnerV1): void {
  assertDecodedSize(owner.byteLength);
  if (owner.released) {
    throw new Error("Decoded memory admission was already released.");
  }
}

function readDecodedAdmission(
  admission: PersistenceDecodedByteOwnerV1 | number,
): number {
  if (typeof admission === "number") {
    assertDecodedSize(admission);
    return admission;
  }
  assertActiveDecodedOwner(admission);
  return admission.byteLength;
}
