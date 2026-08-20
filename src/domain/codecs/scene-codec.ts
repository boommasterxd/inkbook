import type { TextBoundaryAnchor } from "../model";
import type { RuntimeSceneStateV1, SerializedSceneStateV1 } from "../scene";
import { materializeSerializedSceneStateV1 } from "../scene";
import { closedRecord } from "../model/validation-support";
import { parseBoundedJson } from "./bounded-json";
import { encodeCanonicalJson } from "./canonical-json";
import {
  SCENE_RESOURCE_LIMITS_V1,
  validateBoundedSerializedSceneStateV1,
  validateSerializedSceneStateV1,
} from "./scene-validation";

const CURRENT_SCHEMA_MAJOR = 1;
const CURRENT_SCHEMA_MINOR = 0;
const MAX_JSON_STRING_UTF16 = 5_333_334;
const MAX_JSON_ARRAY_ITEMS = Number("500000");
const MAX_JSON_OBJECT_MEMBERS = Number("1000000");
const MAX_JSON_OBJECT_MEMBERS_PER_OBJECT = 64;
const MAX_JSON_VALUES = Number("5000000");
const BYTE_ORDER_MARK = "\ufeff";
const ANCHOR_CONTEXT_WRITE_LIMIT = 128;
const SCENE_JSON_LIMITS = Object.freeze({
  maxUtf8Bytes: SCENE_RESOURCE_LIMITS_V1.maxUtf8Bytes,
  maxNesting: SCENE_RESOURCE_LIMITS_V1.maxJsonNesting,
  maxStringUtf16Units: MAX_JSON_STRING_UTF16,
  maxArrayItems: MAX_JSON_ARRAY_ITEMS,
  maxObjectMembers: MAX_JSON_OBJECT_MEMBERS,
  maxObjectMembersPerObject: MAX_JSON_OBJECT_MEMBERS_PER_OBJECT,
  maxArrays: Number("500000"),
  maxObjects: Number("1000000"),
});

interface SceneSchemaVersionV1 {
  readonly major: number;
  readonly minor: number;
}

export type SceneDecodeResultV1 =
  | {
      readonly kind: "current";
      readonly scene: RuntimeSceneStateV1;
      readonly schemaVersion: SceneSchemaVersionV1;
    }
  | {
      readonly kind: "read-only-newer-version";
      readonly schemaVersion: SceneSchemaVersionV1;
    };

function decodeInput(input: string | Uint8Array): string {
  if (typeof input === "string") {
    if (input.startsWith(BYTE_ORDER_MARK))
      throw new SyntaxError("Scene JSON cannot contain a BOM.");
    return input;
  }
  if (input.byteLength > SCENE_RESOURCE_LIMITS_V1.maxUtf8Bytes) {
    throw new RangeError("Scene JSON exceeds the V1 byte limit.");
  }
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(input);
  if (decoded.startsWith(BYTE_ORDER_MARK))
    throw new SyntaxError("Scene JSON cannot contain a BOM.");
  return decoded;
}

function validateSchemaVersion(value: unknown): SceneSchemaVersionV1 {
  const data = closedRecord(value, ["major", "minor"], "Scene schema version");
  if (
    !Number.isSafeInteger(data.major) ||
    !Number.isSafeInteger(data.minor) ||
    (data.major as number) < CURRENT_SCHEMA_MAJOR ||
    (data.minor as number) < 0
  ) {
    throw new RangeError("Scene schema version is unsupported.");
  }
  return Object.freeze({
    major: data.major as number,
    minor: data.minor as number,
  });
}

function isCurrent(version: SceneSchemaVersionV1): boolean {
  return (
    version.major === CURRENT_SCHEMA_MAJOR &&
    version.minor === CURRENT_SCHEMA_MINOR
  );
}

function assertFutureRoot(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A future scene must remain a bounded JSON object.");
  }
}

function validateFutureStructure(value: unknown): void {
  assertFutureRoot(value);
  const encoded = encodeCanonicalJson(value);
  const stack: unknown[] = [value];
  const visited = new Set<object>();
  let arrayItems = 0;
  let objectMembers = 0;
  let values = 0;
  while (stack.length > 0) {
    const candidate = stack.pop();
    values += 1;
    if (values > MAX_JSON_VALUES) {
      throw new RangeError("Future scene exceeds the bounded value count.");
    }
    if (candidate === null || typeof candidate !== "object") continue;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      arrayItems += candidate.length;
      if (arrayItems > MAX_JSON_ARRAY_ITEMS) {
        throw new RangeError(
          "Future scene exceeds the bounded array-item count.",
        );
      }
      for (const item of candidate) stack.push(item);
    } else {
      const members = Object.values(candidate);
      objectMembers += members.length;
      if (objectMembers > MAX_JSON_OBJECT_MEMBERS) {
        throw new RangeError(
          "Future scene exceeds the bounded object-member count.",
        );
      }
      for (const member of members) stack.push(member);
    }
  }
  if (encoded.byteLength > SCENE_RESOURCE_LIMITS_V1.maxUtf8Bytes) {
    throw new RangeError("Future scene exceeds the V1 read-only byte limit.");
  }
}

function validateBoundedFutureStructure(
  value: unknown,
  measuredUtf8Bytes: number,
): void {
  assertFutureRoot(value);
  if (
    !Number.isSafeInteger(measuredUtf8Bytes) ||
    measuredUtf8Bytes < 0 ||
    measuredUtf8Bytes > SCENE_RESOURCE_LIMITS_V1.maxUtf8Bytes
  ) {
    throw new RangeError("Future scene exceeds the V1 read-only byte limit.");
  }
}

function readOnlyResult(version: SceneSchemaVersionV1): SceneDecodeResultV1 {
  return Object.freeze({
    kind: "read-only-newer-version",
    schemaVersion: version,
  });
}

export function decodeSceneStateV1(
  value: unknown,
  schemaVersion: unknown,
): SceneDecodeResultV1 {
  const version = validateSchemaVersion(schemaVersion);
  if (!isCurrent(version)) {
    validateFutureStructure(value);
    return readOnlyResult(version);
  }
  return Object.freeze({
    kind: "current",
    scene: validateSerializedSceneStateV1(value),
    schemaVersion: version,
  });
}

export function decodeSceneJsonV1(
  input: string | Uint8Array,
  schemaVersion: unknown,
): SceneDecodeResultV1 {
  const parsed = parseBoundedJson(decodeInput(input), SCENE_JSON_LIMITS);
  if (!parsed.ok) {
    throw new SyntaxError(
      `${parsed.error.code} at UTF-16 offset ${String(parsed.error.offset)}: ${parsed.error.message}`,
    );
  }
  const version = validateSchemaVersion(schemaVersion);
  if (!isCurrent(version)) {
    validateBoundedFutureStructure(parsed.value, parsed.counters.utf8Bytes);
    return readOnlyResult(version);
  }
  return Object.freeze({
    kind: "current",
    scene: validateBoundedSerializedSceneStateV1(
      parsed.value,
      parsed.counters.utf8Bytes,
    ),
    schemaVersion: version,
  });
}

function assertWritableAnchorContexts(scene: SerializedSceneStateV1): void {
  for (const element of scene.elements) {
    const binding = element.binding;
    let anchors: readonly TextBoundaryAnchor[] = [];
    if (binding.kind === "text-range") anchors = [binding.start, binding.end];
    if (binding.kind === "text-position") anchors = [binding.anchor];
    for (const anchor of anchors) {
      if (
        anchor.contextBefore.length > ANCHOR_CONTEXT_WRITE_LIMIT ||
        anchor.contextAfter.length > ANCHOR_CONTEXT_WRITE_LIMIT
      ) {
        throw new RangeError(
          "V1 writes require anchor contexts of at most 128 UTF-16 units.",
        );
      }
    }
  }
}

export function serializeRuntimeSceneStateV1(
  scene: RuntimeSceneStateV1,
): SerializedSceneStateV1 {
  const serialized = materializeSerializedSceneStateV1(scene);
  assertWritableAnchorContexts(serialized);
  validateSerializedSceneStateV1(serialized);
  return serialized;
}

export function encodeRuntimeSceneJsonV1(
  scene: RuntimeSceneStateV1,
): Uint8Array {
  return encodeCanonicalJson(serializeRuntimeSceneStateV1(scene));
}
