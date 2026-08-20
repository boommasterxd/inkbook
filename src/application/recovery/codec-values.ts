import type { BoundedJsonErrorCode } from "../../domain/codecs/bounded-json";
import type { AnnotationPatchV1 } from "../../domain/operations";
import { validateAnnotationPatchV1 } from "../../domain/operations";
import {
  createHostTransactionSequence,
  createSidecarRevision,
  parseHostEffectId,
  parseSha256Digest,
  parseViewId,
} from "../note-session/value-objects";
import type { NoteIdentityV1, Sha256Digest } from "../note-session/types";
import type { SourceOffsetSpanV1 } from "../source-coordination/types";
import type { SidecarBaseIdentityV1 } from "./base";
import type {
  FileRelocationRecordV1,
  HostAcknowledgementV1,
  PrefixRelocationRecordV1,
  RemovalRecordV1,
} from "./types";
import {
  isNormalizedVaultPath,
  isValidNoteIdentity,
  isValidSidecarBase,
} from "./validation";

export type DataRecord = Record<string, unknown>;

export function asRecord(value: unknown): DataRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a record.");
  }
  return value as DataRecord;
}

export function exactKeys(value: DataRecord, keys: readonly string[]): void {
  const compare = (left: string, right: string): number =>
    left.localeCompare(right);
  const actual = Object.keys(value).sort(compare);
  const expected = [...keys].sort(compare);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError("Unexpected record fields.");
  }
  for (const key of keys) dataPropertyValue(value, key);
}

export function dataPropertyValue(value: DataRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !("value" in descriptor)
  ) {
    throw new TypeError("Expected an enumerable own data property.");
  }
  return descriptor.value;
}

export function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected a string.");
  return value;
}

export function numberValue(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("Expected a number.");
  return value;
}

export function positiveInteger(value: unknown): number {
  const number = numberValue(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError("Expected a positive integer.");
  }
  return number;
}

export function nonNegativeInteger(value: unknown): number {
  const number = numberValue(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError("Expected a non-negative integer.");
  }
  return number;
}

export function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("Expected a boolean.");
  return value;
}

export function arrayValue(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Expected an array.");
  return value;
}

export function fileStep(value: unknown): FileRelocationRecordV1["step"] {
  const steps: readonly unknown[] = [
    "prepared",
    "sidecar-moved",
    "identities-rekeyed",
    "sidecar-metadata-saved",
    "marker-saved",
    "checkpoint-acknowledged",
    "complete",
  ];
  if (!steps.includes(value)) {
    throw new TypeError("Invalid file relocation step.");
  }
  return value as FileRelocationRecordV1["step"];
}

export function prefixStep(value: unknown): PrefixRelocationRecordV1["step"] {
  if (value !== "prepared" && value !== "processing" && value !== "complete") {
    throw new TypeError("Invalid prefix relocation step.");
  }
  return value;
}

export function markerState(value: unknown): RemovalRecordV1["markerState"] {
  if (value !== "present" && value !== "removing" && value !== "removed") {
    throw new TypeError("Invalid removal marker state.");
  }
  return value;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

export function jsonErrorCode(
  code: BoundedJsonErrorCode,
): "invalid-command" | "recovery-limit" {
  switch (code) {
    case "utf8-byte-limit":
    case "nesting-limit":
    case "string-limit":
    case "array-item-limit":
    case "object-member-limit":
    case "array-limit":
    case "object-limit":
      return "recovery-limit";
    default:
      return "invalid-command";
  }
}

export function patchValue(value: unknown): AnnotationPatchV1 {
  const result = validateAnnotationPatchV1(value);
  if (!result.ok) throw new TypeError("Invalid annotation patch.");
  return result.value;
}

export function acknowledgementValue(
  value: unknown,
  direction: "forward" | "inverse",
): HostAcknowledgementV1 {
  const data = asRecord(value);
  exactKeys(data, [
    "direction",
    "editorViewId",
    "effectId",
    "transactionSequence",
  ]);
  if (data.direction !== direction) {
    throw new TypeError("Invalid host direction.");
  }
  return Object.freeze({
    direction,
    editorViewId: parseViewId(stringValue(data.editorViewId)),
    effectId: parseHostEffectId(stringValue(data.effectId)),
    transactionSequence: createHostTransactionSequence(
      numberValue(data.transactionSequence),
    ),
  });
}

export function sidecarBaseValue(value: unknown): SidecarBaseIdentityV1 {
  const data = asRecord(value);
  exactKeys(data, [
    "markdownPath",
    "rawTextSha256",
    "revision",
    "vaultRelativePath",
  ]);
  const markdownPath = stringValue(data.markdownPath);
  const vaultRelativePath = stringValue(data.vaultRelativePath);
  if (
    !isNormalizedVaultPath(markdownPath) ||
    !isNormalizedVaultPath(vaultRelativePath)
  ) {
    throw new TypeError("Invalid sidecar base path.");
  }
  const base = Object.freeze({
    markdownPath,
    rawTextSha256: nullableDigest(data.rawTextSha256),
    revision:
      data.revision === null
        ? null
        : createSidecarRevision(numberValue(data.revision)),
    vaultRelativePath,
  });
  if (!isValidSidecarBase(base)) {
    throw new TypeError("Invalid sidecar base version.");
  }
  return base;
}

export function noteIdentityValue(value: unknown): NoteIdentityV1 {
  const data = asRecord(value);
  exactKeys(data, ["vaultIdHint", "vaultRelativeMarkdownPath"]);
  const note = Object.freeze({
    vaultIdHint: stringValue(data.vaultIdHint),
    vaultRelativeMarkdownPath: stringValue(data.vaultRelativeMarkdownPath),
  });
  if (!isValidNoteIdentity(note)) throw new TypeError("Invalid note identity.");
  return note;
}

export function sourceOffsetSpanValue(value: unknown): SourceOffsetSpanV1 {
  const data = asRecord(value);
  exactKeys(data, ["newFromUtf16", "newToUtf16", "oldFromUtf16", "oldToUtf16"]);
  return Object.freeze({
    newFromUtf16: nonNegativeInteger(data.newFromUtf16),
    newToUtf16: nonNegativeInteger(data.newToUtf16),
    oldFromUtf16: nonNegativeInteger(data.oldFromUtf16),
    oldToUtf16: nonNegativeInteger(data.oldToUtf16),
  });
}

function nullableDigest(value: unknown): Sha256Digest | null {
  return value === null ? null : parseSha256Digest(stringValue(value));
}
