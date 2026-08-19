import { decodeRecord } from "./record-codec";
import type { StoredAttempt } from "./schema";
import type { RecoveryProbeRecord } from "./types";

export interface ValidatedStoredAttempt {
  readonly stored: StoredAttempt;
  readonly record: RecoveryProbeRecord;
}

export function validateStoredAttempt(
  value: unknown,
  expectedKey?: string,
): ValidatedStoredAttempt | null {
  if (!isObject(value)) {
    return null;
  }
  if (
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .join(",") !== "byteSize,key,noteKey,serialized"
  ) {
    return null;
  }
  const { key, noteKey, serialized, byteSize } = value;
  if (
    typeof key !== "string" ||
    typeof noteKey !== "string" ||
    typeof serialized !== "string" ||
    typeof byteSize !== "number" ||
    !Number.isSafeInteger(byteSize) ||
    byteSize < 0 ||
    (expectedKey !== undefined && key !== expectedKey) ||
    new TextEncoder().encode(serialized).byteLength !== byteSize
  ) {
    return null;
  }
  const record = decodeRecord(serialized);
  if (record === null) {
    return null;
  }
  return {
    stored: { key, noteKey, serialized, byteSize },
    record,
  };
}

export function createStoredAttempt(
  key: string,
  noteKey: string,
  serialized: string,
): StoredAttempt {
  return {
    key,
    noteKey,
    serialized,
    byteSize: new TextEncoder().encode(serialized).byteLength,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
