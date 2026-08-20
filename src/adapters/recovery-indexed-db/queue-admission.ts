import type { CommandResultV1 } from "../../application/note-session";
import {
  decodeRecoveryRecordV1,
  encodeRecoveryRecordV1,
  type RecoveryPersistenceRecordV1,
} from "../../application/recovery";
import { encodeCanonicalJson } from "../../domain/codecs/canonical-json";

const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- Small queued control requests have a fixed 512 KiB ceiling.
const MAX_SMALL_REQUEST_BYTES = 512 * KIBIBYTE;
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- Control requests reserve half their byte ceiling for cumulative UTF-16 data before encoding.
const MAX_SMALL_REQUEST_STRING_UNITS = 256 * KIBIBYTE;
const MAX_SMALL_REQUEST_NODES = 16_384;
const MAX_SMALL_REQUEST_DEPTH = 32;
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- Recovery records already own an 8 MiB codec ceiling.
const MAX_RECORD_STRING_UNITS = 8 * MEBIBYTE;
const MAX_RECORD_NODES = 1_048_576;
const MAX_RECORD_DEPTH = 64;
const TRANSITION_PROPERTY_COUNT = 2;

class AdmissionLimitError extends Error {}

interface MaterializationLimits {
  readonly depth: number;
  readonly nodes: number;
  readonly stringUnits: number;
}

interface MaterializationState {
  nodes: number;
  readonly seen: Set<object>;
  stringUnits: number;
}

export interface AdmittedRecoveryRecord<T extends RecoveryPersistenceRecordV1> {
  readonly bytes: Uint8Array;
  readonly record: T;
}

export interface AdmittedRecoveryTransition<
  TExpected extends RecoveryPersistenceRecordV1,
  TReplacement extends RecoveryPersistenceRecordV1,
> {
  readonly byteSize: number;
  readonly expectedBytes: Uint8Array;
  readonly replacementBytes: Uint8Array;
  readonly transition: Readonly<{
    expected: TExpected;
    replacement: TReplacement;
  }>;
}

export interface AdmittedQueueRequest<T> {
  readonly byteSize: number;
  readonly value: T;
}

const RECORD_LIMITS: MaterializationLimits = Object.freeze({
  depth: MAX_RECORD_DEPTH,
  nodes: MAX_RECORD_NODES,
  stringUnits: MAX_RECORD_STRING_UNITS,
});
const SMALL_REQUEST_LIMITS: MaterializationLimits = Object.freeze({
  depth: MAX_SMALL_REQUEST_DEPTH,
  nodes: MAX_SMALL_REQUEST_NODES,
  stringUnits: MAX_SMALL_REQUEST_STRING_UNITS,
});

export function admitRecoveryRecord<T extends RecoveryPersistenceRecordV1>(
  value: T,
): CommandResultV1<AdmittedRecoveryRecord<T>> {
  let materialized: T;
  try {
    materialized = materializeData(
      value,
      { nodes: 0, seen: new Set<object>(), stringUnits: 0 },
      RECORD_LIMITS,
      0,
    ) as T;
  } catch (error) {
    return admissionFailure(error);
  }
  const encoded = encodeRecoveryRecordV1(materialized);
  if (!encoded.ok) return encoded;
  const decoded = decodeRecoveryRecordV1(encoded.value);
  if (!decoded.ok) return decoded;
  return {
    ok: true,
    value: Object.freeze({
      bytes: encoded.value,
      record: decoded.value as T,
    }),
  };
}

export function admitRecoveryTransition<
  TExpected extends RecoveryPersistenceRecordV1,
  TReplacement extends RecoveryPersistenceRecordV1,
>(
  value: Readonly<{ expected: TExpected; replacement: TReplacement }>,
): CommandResultV1<AdmittedRecoveryTransition<TExpected, TReplacement>> {
  let records: Readonly<{
    expected: TExpected;
    replacement: TReplacement;
  }>;
  try {
    records = readTransitionRecords(value);
  } catch (error) {
    return admissionFailure(error);
  }
  const expected = admitRecoveryRecord(records.expected);
  if (!expected.ok) return expected;
  const replacement = admitRecoveryRecord(records.replacement);
  if (!replacement.ok) return replacement;
  return {
    ok: true,
    value: Object.freeze({
      byteSize:
        expected.value.bytes.byteLength + replacement.value.bytes.byteLength,
      expectedBytes: expected.value.bytes,
      replacementBytes: replacement.value.bytes,
      transition: Object.freeze({
        expected: expected.value.record,
        replacement: replacement.value.record,
      }),
    }),
  };
}

export function admitQueueRequest<T>(
  value: T,
): CommandResultV1<AdmittedQueueRequest<T>> {
  try {
    const cloned = materializeData(
      value,
      { nodes: 0, seen: new Set<object>(), stringUnits: 0 },
      SMALL_REQUEST_LIMITS,
      0,
    ) as T;
    const byteSize = encodeCanonicalJson(cloned).byteLength;
    return byteSize <= MAX_SMALL_REQUEST_BYTES
      ? {
          ok: true,
          value: Object.freeze({ byteSize, value: cloned }),
        }
      : { ok: false, code: "recovery-limit" };
  } catch (error) {
    return admissionFailure(error);
  }
}

function materializeData(
  value: unknown,
  state: MaterializationState,
  limits: MaterializationLimits,
  depth: number,
): unknown {
  state.nodes += 1;
  if (state.nodes > limits.nodes || depth > limits.depth) {
    throw new AdmissionLimitError("Queue value exceeds structural limits.");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    consumeStringUnits(state, limits, value.length);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite number.");
    return value;
  }
  if (typeof value !== "object" || state.seen.has(value)) {
    throw new TypeError("Unsupported queue value.");
  }
  const array = Array.isArray(value);
  const arrayLength = array ? readArrayLength(value) : undefined;
  if (arrayLength !== undefined && arrayLength > limits.nodes - state.nodes) {
    throw new AdmissionLimitError("Queue array exceeds its node budget.");
  }
  state.seen.add(value);
  try {
    return array
      ? materializeArray(value, arrayLength ?? 0, state, limits, depth)
      : materializeRecord(value, state, limits, depth);
  } finally {
    state.seen.delete(value);
  }
}

function materializeArray(
  value: readonly unknown[],
  expectedLength: number,
  state: MaterializationState,
  limits: MaterializationLimits,
  depth: number,
): readonly unknown[] {
  const keys = readStringKeys(value).filter((key) => key !== "length");
  if (keys.length !== expectedLength) throw new TypeError("Sparse array.");
  reservePropertyKeys(keys, state, limits);
  if (readArrayLength(value) !== expectedLength) {
    throw new TypeError("Unstable array length.");
  }
  const result: unknown[] = [];
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable) {
      throw new TypeError("Non-enumerable array value.");
    }
    result.push(
      materializeData(
        dataDescriptorValue(descriptor),
        state,
        limits,
        depth + 1,
      ),
    );
  }
  return Object.freeze(result);
}

function materializeRecord(
  value: object,
  state: MaterializationState,
  limits: MaterializationLimits,
  depth: number,
): Readonly<Record<string, unknown>> {
  const keys = readStringKeys(value);
  reservePropertyKeys(keys, state, limits);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) {
      throw new TypeError("Non-enumerable property.");
    }
    result[key] = materializeData(
      dataDescriptorValue(descriptor),
      state,
      limits,
      depth + 1,
    );
  }
  return Object.freeze(result);
}

function readTransitionRecords<
  TExpected extends RecoveryPersistenceRecordV1,
  TReplacement extends RecoveryPersistenceRecordV1,
>(
  value: Readonly<{ expected: TExpected; replacement: TReplacement }>,
): Readonly<{ expected: TExpected; replacement: TReplacement }> {
  const keys = readStringKeys(value);
  const expected = Object.getOwnPropertyDescriptor(value, "expected");
  const replacement = Object.getOwnPropertyDescriptor(value, "replacement");
  if (
    keys.length !== TRANSITION_PROPERTY_COUNT ||
    !keys.includes("expected") ||
    !keys.includes("replacement") ||
    expected?.enumerable !== true ||
    replacement?.enumerable !== true
  ) {
    throw new TypeError("Invalid recovery transition wrapper.");
  }
  return Object.freeze({
    expected: dataDescriptorValue(expected) as TExpected,
    replacement: dataDescriptorValue(replacement) as TReplacement,
  });
}

function readArrayLength(value: readonly unknown[]): number {
  const length = dataDescriptorValue(
    Object.getOwnPropertyDescriptor(value, "length"),
  );
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw new TypeError("Invalid array length.");
  }
  return length as number;
}

function dataDescriptorValue(
  descriptor: PropertyDescriptor | undefined,
): unknown {
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError("Accessor property.");
  }
  return descriptor.value;
}

function readStringKeys(value: object): readonly string[] {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Symbol key.");
  }
  return keys as readonly string[];
}

function reservePropertyKeys(
  keys: readonly string[],
  state: MaterializationState,
  limits: MaterializationLimits,
): void {
  if (keys.length > limits.nodes - state.nodes) {
    throw new AdmissionLimitError("Queue object exceeds its node budget.");
  }
  for (const key of keys) consumeStringUnits(state, limits, key.length);
}

function consumeStringUnits(
  state: MaterializationState,
  limits: MaterializationLimits,
  units: number,
): void {
  if (units > limits.stringUnits - state.stringUnits) {
    throw new AdmissionLimitError("Queue strings exceed their unit budget.");
  }
  state.stringUnits += units;
}

function admissionFailure(error: unknown): CommandResultV1<never> {
  return {
    ok: false,
    code:
      error instanceof AdmissionLimitError
        ? "recovery-limit"
        : "invalid-command",
  };
}
