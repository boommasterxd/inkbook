import {
  encodeCanonicalSidecarJson,
  parseBoundedJson,
  SCENE_RESOURCE_LIMITS_V1,
} from "../../domain/codecs";
import type { BoundedJsonParseResult } from "../../domain/codecs";
import type {
  InkbookSidecarV1,
  PreparedCanonicalSidecarV1,
  SidecarDecodeResultV1,
  SidecarWritableTierV1,
} from "./types";
export type { PreparedCanonicalSidecarV1 } from "./types";
import {
  validateBoundedInkbookSidecarV1,
  validateSidecarVersionStructure,
} from "./validation";
import { createPreparedCanonicalSidecarProcessorV1 } from "./prepared-sidecar-processor";

const BYTE_ORDER_MARK = "\ufeff";
const CURRENT_MAJOR = 1;
const CURRENT_MINOR = 0;
const MAX_JSON_STRING_UTF16 = 5_333_334;
const MAX_JSON_COLLECTION_ITEMS = 500_000;
const MAX_JSON_OBJECT_MEMBERS = 1_000_000;
const MAX_JSON_OBJECT_MEMBERS_PER_OBJECT = 64;
const MEBIBYTE = 1_048_576;
const SIDECAR_READ_MAX_BYTES = Number("16") * MEBIBYTE;
const PHONE_WRITE_MAX_BYTES = Number("8") * MEBIBYTE;
const DESKTOP_TABLET_WRITE_MAX_BYTES = Number("16") * MEBIBYTE;

export const SIDECAR_RESOURCE_LIMITS_V1 = Object.freeze({
  maxUtf8Bytes: SIDECAR_READ_MAX_BYTES,
  maxNesting: SCENE_RESOURCE_LIMITS_V1.maxJsonNesting,
  maxStringUtf16Units: MAX_JSON_STRING_UTF16,
  maxArrayItems: MAX_JSON_COLLECTION_ITEMS,
  maxObjectMembers: MAX_JSON_OBJECT_MEMBERS,
  maxObjectMembersPerObject: MAX_JSON_OBJECT_MEMBERS_PER_OBJECT,
  maxArrays: MAX_JSON_COLLECTION_ITEMS,
  maxObjects: MAX_JSON_OBJECT_MEMBERS,
});

export const SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1 = Object.freeze({
  phone: PHONE_WRITE_MAX_BYTES,
  "desktop-tablet": DESKTOP_TABLET_WRITE_MAX_BYTES,
});

function decodeInput(input: string | Uint8Array): string {
  if (typeof input === "string") {
    if (input.startsWith(BYTE_ORDER_MARK)) {
      throw new SyntaxError("Sidecar JSON cannot contain a BOM.");
    }
    return input;
  }
  if (input.byteLength > SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes) {
    throw new RangeError("Sidecar JSON exceeds the V1 byte limit.");
  }
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(input);
  if (decoded.startsWith(BYTE_ORDER_MARK)) {
    throw new SyntaxError("Sidecar JSON cannot contain a BOM.");
  }
  return decoded;
}

function decodeParsedSidecar(
  value: unknown,
  measuredUtf8Bytes: number,
): SidecarDecodeResultV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Inkbook sidecar must be a bounded JSON object.");
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.format !== "inkbook-obsidian-annotations") {
    throw new TypeError("Sidecar format is unsupported.");
  }
  const schemaVersion = validateSidecarVersionStructure(envelope.schemaVersion);
  if (
    schemaVersion.major !== CURRENT_MAJOR ||
    schemaVersion.minor !== CURRENT_MINOR
  ) {
    return Object.freeze({
      kind: "read-only-newer-version",
      schemaVersion,
    });
  }
  return Object.freeze({
    kind: "current",
    sidecar: validateBoundedInkbookSidecarV1(value, measuredUtf8Bytes),
  });
}

export function decodeInkbookSidecarV1(
  input: string | Uint8Array,
): SidecarDecodeResultV1 {
  const parsed = parseBoundedJson(
    decodeInput(input),
    SIDECAR_RESOURCE_LIMITS_V1,
  );
  return decodeBoundedInkbookSidecarV1(parsed);
}

export function decodeBoundedInkbookSidecarV1(
  parsed: BoundedJsonParseResult,
): SidecarDecodeResultV1 {
  if (!parsed.ok) {
    throw new SyntaxError(
      `${parsed.error.code} at UTF-16 offset ${String(parsed.error.offset)}: ${parsed.error.message}`,
    );
  }
  return decodeParsedSidecar(parsed.value, parsed.counters.utf8Bytes);
}

export function encodeInkbookSidecarV1(
  sidecar: InkbookSidecarV1,
  writableTier: SidecarWritableTierV1,
): Uint8Array {
  const prepared = prepareCanonicalSidecarV1(sidecar);
  const encoded = encodeCanonicalSidecarJson({
    ...prepared.sidecarWithoutElements,
    scene: {
      ...prepared.sidecarWithoutElements.scene,
      elements: prepared.elements,
    },
  });
  assertWritableSidecarSizeV1(encoded.byteLength, writableTier);
  return encoded;
}

export function prepareCanonicalSidecarV1(
  sidecar: InkbookSidecarV1,
): PreparedCanonicalSidecarV1 {
  const processor = createPreparedCanonicalSidecarProcessorV1(sidecar);
  while (!processor.processNext()) {
    // The synchronous API drives the same resumable preparation pipeline.
  }
  const prepared = processor.complete();
  if (prepared === undefined) {
    throw new Error("Canonical sidecar preparation is incomplete.");
  }
  return prepared;
}

export function assertWritableSidecarSizeV1(
  byteLength: number,
  writableTier: SidecarWritableTierV1,
): void {
  if (byteLength > SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1[writableTier]) {
    throw new RangeError("Encoded sidecar exceeds the V1 write byte limit.");
  }
}
