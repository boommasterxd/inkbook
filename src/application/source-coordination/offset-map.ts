import { encodeCanonicalJson } from "../../domain/codecs/canonical-json";
import { commandFailure, commandSuccess } from "../note-session/results";
import type { CommandResultV1 } from "../note-session/types";
import type { SourceOffsetMapV1, SourceOffsetSpanV1 } from "./types";

const MAX_CHANGED_SPANS = 65_536;
const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
const MAX_CANONICAL_MAP_BYTES = 4 * MEBIBYTE;

export function validateSourceOffsetMap(
  value: unknown,
  priorUtf16Length: number,
  replacementUtf16Length: number,
): CommandResultV1<SourceOffsetMapV1> {
  if (
    !isNonNegativeSafeInteger(priorUtf16Length) ||
    !isNonNegativeSafeInteger(replacementUtf16Length)
  ) {
    return commandFailure("resource-limit");
  }
  let candidateSpans: readonly unknown[] | null;
  try {
    candidateSpans = readSpans(value);
  } catch {
    return commandFailure("invalid-command");
  }
  if (candidateSpans === null) return commandFailure("invalid-command");
  if (candidateSpans.length > MAX_CHANGED_SPANS) {
    return commandFailure("resource-limit");
  }
  let spans: readonly SourceOffsetSpanV1[] | null;
  try {
    spans = materializeSpans(candidateSpans);
  } catch {
    return commandFailure("invalid-command");
  }
  if (spans === null) return commandFailure("invalid-command");
  if (!hasCanonicalSpans(spans, priorUtf16Length, replacementUtf16Length)) {
    return commandFailure("invalid-command");
  }
  const offsetMap = Object.freeze({ spans: Object.freeze(spans) });
  try {
    if (
      encodedMapBytes(offsetMap, priorUtf16Length, replacementUtf16Length) >
      MAX_CANONICAL_MAP_BYTES
    ) {
      return commandFailure("resource-limit");
    }
  } catch {
    return commandFailure("invalid-command");
  }
  return commandSuccess(offsetMap);
}

function readSpans(value: unknown): readonly unknown[] | null {
  const data = readClosedDataRecord(value, ["spans"]);
  return data !== null && Array.isArray(data.spans) ? data.spans : null;
}

function materializeSpans(
  values: readonly unknown[],
): readonly SourceOffsetSpanV1[] | null {
  const spans: SourceOffsetSpanV1[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(values, index);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    const span = materializeSpan(descriptor.value);
    if (span === null) return null;
    spans.push(span);
  }
  return spans;
}

function materializeSpan(value: unknown): SourceOffsetSpanV1 | null {
  const data = readClosedDataRecord(value, [
    "newFromUtf16",
    "newToUtf16",
    "oldFromUtf16",
    "oldToUtf16",
  ]);
  if (
    data === null ||
    typeof data.newFromUtf16 !== "number" ||
    typeof data.newToUtf16 !== "number" ||
    typeof data.oldFromUtf16 !== "number" ||
    typeof data.oldToUtf16 !== "number"
  ) {
    return null;
  }
  return Object.freeze({
    newFromUtf16: data.newFromUtf16,
    newToUtf16: data.newToUtf16,
    oldFromUtf16: data.oldFromUtf16,
    oldToUtf16: data.oldToUtf16,
  });
}

function readClosedDataRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== expected.length) return null;
  const result: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCanonicalSpans(
  spans: readonly SourceOffsetSpanV1[],
  priorLength: number,
  replacementLength: number,
): boolean {
  if (spans.length === 0) return priorLength === replacementLength;
  let priorOldTo = 0;
  let priorNewTo = 0;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    if (span === undefined) return false;
    if (!isValidSpan(span, priorLength, replacementLength)) return false;
    const oldGap = span.oldFromUtf16 - priorOldTo;
    const newGap = span.newFromUtf16 - priorNewTo;
    if (oldGap !== newGap) return false;
    if (index > 0 && oldGap <= 0) return false;
    if (index === 0 && oldGap < 0) return false;
    priorOldTo = span.oldToUtf16;
    priorNewTo = span.newToUtf16;
  }
  return priorLength - priorOldTo === replacementLength - priorNewTo;
}

function isValidSpan(
  span: SourceOffsetSpanV1,
  priorLength: number,
  replacementLength: number,
): boolean {
  return (
    isNonNegativeSafeInteger(span.oldFromUtf16) &&
    isNonNegativeSafeInteger(span.oldToUtf16) &&
    isNonNegativeSafeInteger(span.newFromUtf16) &&
    isNonNegativeSafeInteger(span.newToUtf16) &&
    span.oldFromUtf16 <= span.oldToUtf16 &&
    span.newFromUtf16 <= span.newToUtf16 &&
    span.oldToUtf16 <= priorLength &&
    span.newToUtf16 <= replacementLength
  );
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function encodedMapBytes(
  offsetMap: SourceOffsetMapV1,
  priorUtf16Length: number,
  replacementUtf16Length: number,
): number {
  return encodeCanonicalJson({
    priorUtf16Length,
    replacementUtf16Length,
    spans: offsetMap.spans,
  }).byteLength;
}
