import { commandFailure, commandSuccess } from "../note-session/results";
import { closedRecord } from "../../domain/model/validation-support";
import type { CommandResultV1, Sha256Digest } from "../note-session/types";
import { parseSha256Digest } from "../note-session/value-objects";
import { SOURCE_COORDINATION_LIMITS_V1 } from "./limits";
import type {
  SourceOffsetMapIdentityV1,
  SourceOffsetMapV1,
  SourceOffsetSpanV1,
  StreamingSha256PortV1,
  StreamingSha256SinkV1,
} from "./types";

const JSON_CHUNK_UTF16 = 32_768;
const ASSOCIATION_BEFORE = -1;
const ASSOCIATION_AFTER = 1;
const LAST_ITEM_OFFSET = 1;

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
  if (candidateSpans.length > SOURCE_COORDINATION_LIMITS_V1.maxChangedSpans) {
    return commandFailure("resource-limit");
  }
  let materialized: CommandResultV1<MaterializedSpansV1>;
  try {
    materialized = materializeSpans(
      candidateSpans,
      priorUtf16Length,
      replacementUtf16Length,
    );
  } catch {
    return commandFailure("invalid-command");
  }
  if (!materialized.ok) return materialized;
  if (
    !hasCanonicalSpans(
      materialized.value.spans,
      priorUtf16Length,
      replacementUtf16Length,
    )
  ) {
    return commandFailure("invalid-command");
  }
  const offsetMap = Object.freeze({
    spans: Object.freeze(materialized.value.spans),
  });
  return commandSuccess(offsetMap);
}

export function mapSourceOffset(
  offsetMap: SourceOffsetMapV1,
  priorUtf16Length: number,
  replacementUtf16Length: number,
  offset: number,
  association: "before" | "after",
): CommandResultV1<number> {
  const validated = validateSourceOffsetMap(
    offsetMap,
    priorUtf16Length,
    replacementUtf16Length,
  );
  if (!validated.ok) return validated;
  if (!isNonNegativeSafeInteger(offset) || offset > priorUtf16Length) {
    return commandFailure("invalid-command");
  }
  return commandSuccess(
    mapBoundary(
      validated.value.spans,
      offset,
      association === "before" ? ASSOCIATION_BEFORE : ASSOCIATION_AFTER,
    ),
  );
}

export function composeSourceOffsetMaps(
  first: SourceOffsetMapV1,
  second: SourceOffsetMapV1,
  priorUtf16Length: number,
  intermediateUtf16Length: number,
  replacementUtf16Length: number,
): CommandResultV1<SourceOffsetMapV1> {
  const firstResult = validateSourceOffsetMap(
    first,
    priorUtf16Length,
    intermediateUtf16Length,
  );
  if (!firstResult.ok) return firstResult;
  const secondResult = validateSourceOffsetMap(
    second,
    intermediateUtf16Length,
    replacementUtf16Length,
  );
  if (!secondResult.ok) return secondResult;
  const preflightCount = first.spans.length + second.spans.length;
  if (preflightCount > SOURCE_COORDINATION_LIMITS_V1.maxChangedSpans) {
    return commandFailure("resource-limit");
  }
  const candidates = collectCompositionCandidates(
    firstResult.value,
    secondResult.value,
  );
  const spans = mergeCompositionCandidates(candidates);
  return validateSourceOffsetMap(
    { spans },
    priorUtf16Length,
    replacementUtf16Length,
  );
}

export async function identifySourceOffsetMap(
  port: StreamingSha256PortV1,
  offsetMap: SourceOffsetMapV1,
  priorUtf16Length: number,
  replacementUtf16Length: number,
): Promise<CommandResultV1<SourceOffsetMapIdentityV1>> {
  const validated = validateSourceOffsetMap(
    offsetMap,
    priorUtf16Length,
    replacementUtf16Length,
  );
  if (!validated.ok) return validated;
  const encodedBytes = encodedSourceOffsetMapBytes(
    validated.value,
    priorUtf16Length,
    replacementUtf16Length,
  );
  const digest = await digestCanonicalMap(
    port,
    validated.value,
    priorUtf16Length,
    replacementUtf16Length,
  );
  if (!digest.ok) return digest;
  return commandSuccess(
    Object.freeze({
      digest: digest.value,
      encodedBytes,
      offsetMap: validated.value,
      priorUtf16Length,
      replacementUtf16Length,
    }),
  );
}

function readSpans(value: unknown): readonly unknown[] | null {
  const data = closedRecord(value, ["spans"], "Source offset map");
  return Array.isArray(data.spans) ? data.spans : null;
}

interface MaterializedSpansV1 {
  readonly spans: readonly SourceOffsetSpanV1[];
}

function materializeSpans(
  values: readonly unknown[],
  priorUtf16Length: number,
  replacementUtf16Length: number,
): CommandResultV1<MaterializedSpansV1> {
  const spans: SourceOffsetSpanV1[] = [];
  let encodedBytes = encodedMapEnvelopeBytes(
    priorUtf16Length,
    replacementUtf16Length,
  );
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(values, index);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return commandFailure("invalid-command");
    }
    const span = materializeSpan(descriptor.value);
    if (span === null) return commandFailure("invalid-command");
    encodedBytes += encodedSpanBytes(span) + (index === 0 ? 0 : 1);
    if (encodedBytes > SOURCE_COORDINATION_LIMITS_V1.maxEncodedOffsetMapBytes) {
      return commandFailure("resource-limit");
    }
    spans.push(span);
  }
  return commandSuccess(Object.freeze({ spans }));
}

function materializeSpan(value: unknown): SourceOffsetSpanV1 | null {
  const data = closedRecord(
    value,
    ["newFromUtf16", "newToUtf16", "oldFromUtf16", "oldToUtf16"],
    "Source offset span",
  );
  if (
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
    (span.oldFromUtf16 !== span.oldToUtf16 ||
      span.newFromUtf16 !== span.newToUtf16) &&
    span.oldToUtf16 <= priorLength &&
    span.newToUtf16 <= replacementLength
  );
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function encodedSourceOffsetMapBytes(
  offsetMap: SourceOffsetMapV1,
  priorUtf16Length: number,
  replacementUtf16Length: number,
): number {
  let bytes =
    '{"priorUtf16Length":,"replacementUtf16Length":,"spans":[]}'.length +
    decimalLength(priorUtf16Length) +
    decimalLength(replacementUtf16Length);
  for (const span of offsetMap.spans) {
    bytes +=
      '{"newFromUtf16":,"newToUtf16":,"oldFromUtf16":,"oldToUtf16":}'.length +
      decimalLength(span.newFromUtf16) +
      decimalLength(span.newToUtf16) +
      decimalLength(span.oldFromUtf16) +
      decimalLength(span.oldToUtf16);
  }
  if (offsetMap.spans.length > 1) bytes += offsetMap.spans.length - 1;
  return bytes;
}

function encodedMapEnvelopeBytes(
  priorUtf16Length: number,
  replacementUtf16Length: number,
): number {
  return (
    '{"priorUtf16Length":,"replacementUtf16Length":,"spans":[]}'.length +
    decimalLength(priorUtf16Length) +
    decimalLength(replacementUtf16Length)
  );
}

function encodedSpanBytes(span: SourceOffsetSpanV1): number {
  return (
    '{"newFromUtf16":,"newToUtf16":,"oldFromUtf16":,"oldToUtf16":}'.length +
    decimalLength(span.newFromUtf16) +
    decimalLength(span.newToUtf16) +
    decimalLength(span.oldFromUtf16) +
    decimalLength(span.oldToUtf16)
  );
}

function decimalLength(value: number): number {
  return String(value).length;
}

function collectCompositionCandidates(
  first: SourceOffsetMapV1,
  second: SourceOffsetMapV1,
): SourceOffsetSpanV1[] {
  const candidates: SourceOffsetSpanV1[] = [];
  for (const span of first.spans) {
    candidates.push(
      Object.freeze({
        newFromUtf16: mapBoundary(
          second.spans,
          span.newFromUtf16,
          ASSOCIATION_BEFORE,
        ),
        newToUtf16: mapBoundary(
          second.spans,
          span.newToUtf16,
          ASSOCIATION_AFTER,
        ),
        oldFromUtf16: span.oldFromUtf16,
        oldToUtf16: span.oldToUtf16,
      }),
    );
  }
  const inverseFirst = invertSpans(first.spans);
  for (const span of second.spans) {
    candidates.push(
      Object.freeze({
        newFromUtf16: span.newFromUtf16,
        newToUtf16: span.newToUtf16,
        oldFromUtf16: mapBoundary(
          inverseFirst,
          span.oldFromUtf16,
          ASSOCIATION_BEFORE,
        ),
        oldToUtf16: mapBoundary(
          inverseFirst,
          span.oldToUtf16,
          ASSOCIATION_AFTER,
        ),
      }),
    );
  }
  return candidates;
}

function invertSpans(
  spans: readonly SourceOffsetSpanV1[],
): readonly SourceOffsetSpanV1[] {
  return spans.map((span) =>
    Object.freeze({
      newFromUtf16: span.oldFromUtf16,
      newToUtf16: span.oldToUtf16,
      oldFromUtf16: span.newFromUtf16,
      oldToUtf16: span.newToUtf16,
    }),
  );
}

function mergeCompositionCandidates(
  candidates: SourceOffsetSpanV1[],
): readonly SourceOffsetSpanV1[] {
  candidates.sort(
    (left, right) =>
      left.oldFromUtf16 - right.oldFromUtf16 ||
      left.newFromUtf16 - right.newFromUtf16,
  );
  const result: SourceOffsetSpanV1[] = [];
  for (const candidate of candidates) {
    const prior = result[result.length - LAST_ITEM_OFFSET];
    if (prior === undefined || !spansTouch(prior, candidate)) {
      result.push(candidate);
      continue;
    }
    result[result.length - LAST_ITEM_OFFSET] = Object.freeze({
      newFromUtf16: Math.min(prior.newFromUtf16, candidate.newFromUtf16),
      newToUtf16: Math.max(prior.newToUtf16, candidate.newToUtf16),
      oldFromUtf16: Math.min(prior.oldFromUtf16, candidate.oldFromUtf16),
      oldToUtf16: Math.max(prior.oldToUtf16, candidate.oldToUtf16),
    });
  }
  return Object.freeze(result);
}

function spansTouch(
  left: SourceOffsetSpanV1,
  right: SourceOffsetSpanV1,
): boolean {
  return (
    right.oldFromUtf16 <= left.oldToUtf16 ||
    right.newFromUtf16 <= left.newToUtf16
  );
}

function mapBoundary(
  spans: readonly SourceOffsetSpanV1[],
  offset: number,
  association: number,
): number {
  let delta = 0;
  for (const span of spans) {
    if (offset < span.oldFromUtf16) return offset + delta;
    if (offset > span.oldToUtf16) {
      delta +=
        span.newToUtf16 -
        span.newFromUtf16 -
        (span.oldToUtf16 - span.oldFromUtf16);
      continue;
    }
    return association < 0 ? span.newFromUtf16 : span.newToUtf16;
  }
  return offset + delta;
}

async function digestCanonicalMap(
  port: StreamingSha256PortV1,
  offsetMap: SourceOffsetMapV1,
  priorUtf16Length: number,
  replacementUtf16Length: number,
): Promise<CommandResultV1<Sha256Digest>> {
  const sink = createDigestSink(port);
  if (sink === null) return commandFailure("recovery-unavailable");
  try {
    let chunk = `{"priorUtf16Length":${String(priorUtf16Length)},"replacementUtf16Length":${String(replacementUtf16Length)},"spans":[`;
    for (let index = 0; index < offsetMap.spans.length; index += 1) {
      const span = offsetMap.spans[index];
      if (span === undefined) return commandFailure("invalid-command");
      chunk += `${index === 0 ? "" : ","}{"newFromUtf16":${String(span.newFromUtf16)},"newToUtf16":${String(span.newToUtf16)},"oldFromUtf16":${String(span.oldFromUtf16)},"oldToUtf16":${String(span.oldToUtf16)}}`;
      if (chunk.length >= JSON_CHUNK_UTF16) {
        await sink.update(new TextEncoder().encode(chunk));
        chunk = "";
      }
    }
    await sink.update(new TextEncoder().encode(`${chunk}]}`));
    return commandSuccess(parseSha256Digest(await sink.finish()));
  } catch {
    return commandFailure("recovery-unavailable");
  } finally {
    sink.dispose?.();
  }
}

function createDigestSink(
  port: StreamingSha256PortV1,
): StreamingSha256SinkV1 | null {
  try {
    return port.create();
  } catch {
    return null;
  }
}
