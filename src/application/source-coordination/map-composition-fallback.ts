import { closedRecord } from "../../domain/model/validation-support";
import { commandFailure, commandSuccess } from "../note-session/results";
import type { CommandResultV1 } from "../note-session/types";
import { SOURCE_COORDINATION_LIMITS_V1 } from "./limits";
import { validateSourceOffsetMap } from "./offset-map";
import type { SourceOffsetMapV1, SourceOffsetSpanV1 } from "./types";
import type {
  NormalizedSourceMapCompositionRequestV1,
  SourceMapCompositionSegmentV1,
  SourceMapFallbackSliceResultV1,
  SourceMapFallbackWorkV1,
  SourceMapSliceBudgetV1,
} from "./work-ports";

const ASSOCIATION_BEFORE = -1;
const ASSOCIATION_AFTER = 1;
const ARRAY_LENGTH_PROPERTY_COUNT = 1;
const FLOAT64_BYTES = 8;
const BINARY_DIVISOR = 2;
const PREFIX_SENTINEL_SLOTS = 2;
const LAST_ITEM_OFFSET = 1;
const SPAN_OBJECT_OVERHEAD_BYTES = 64;

export function validateAndNormalizeSourceMapCompositionRequestV1(
  value: unknown,
): CommandResultV1<NormalizedSourceMapCompositionRequestV1> {
  let record: Record<string, unknown>;
  try {
    record = closedRecord(
      value,
      [
        "priorUtf16Length",
        "replacementUtf16Length",
        "scratchByteLimit",
        "segments",
        "wireVersion",
      ],
      "Source map composition request",
    );
  } catch {
    return commandFailure("invalid-command");
  }
  if (
    record.wireVersion !== 1 ||
    !isSafeLength(record.priorUtf16Length) ||
    !isSafeLength(record.replacementUtf16Length) ||
    !isSafeLength(record.scratchByteLimit) ||
    record.scratchByteLimit >
      SOURCE_COORDINATION_LIMITS_V1.maxMappingCompactionScratchBytes ||
    !Array.isArray(record.segments) ||
    record.segments.length === 0 ||
    record.segments.length >
      SOURCE_COORDINATION_LIMITS_V1.maxHistoryMappingNodes
  ) {
    return commandFailure("resource-limit");
  }
  const segments = normalizeSegments(record.segments);
  if (!segments.ok) return segments;
  const first = segments.value[0];
  const last = segments.value[segments.value.length - LAST_ITEM_OFFSET];
  if (
    first?.priorUtf16Length !== record.priorUtf16Length ||
    last?.replacementUtf16Length !== record.replacementUtf16Length
  ) {
    return commandFailure("stale-source");
  }
  const normalized = Object.freeze({
    priorUtf16Length: record.priorUtf16Length,
    replacementUtf16Length: record.replacementUtf16Length,
    scratchByteLimit: record.scratchByteLimit,
    segments: segments.value,
    wireVersion: 1 as const,
  });
  return commandSuccess(normalized as NormalizedSourceMapCompositionRequestV1);
}

export function createSourceMapFallbackWorkV1(
  request: NormalizedSourceMapCompositionRequestV1,
): SourceMapFallbackWorkV1 {
  return new SourceMapFallbackWork(request);
}

class SourceMapFallbackWork implements SourceMapFallbackWorkV1 {
  readonly #request: NormalizedSourceMapCompositionRequestV1;
  #cancelled = false;
  #current: SourceOffsetMapV1;
  #pair: PairComposition | null = null;
  #segmentIndex = 1;

  constructor(request: NormalizedSourceMapCompositionRequestV1) {
    this.#request = request;
    this.#current =
      request.segments[0]?.offsetMap ??
      Object.freeze({ spans: Object.freeze([]) });
  }

  cancel(): void {
    this.#cancelled = true;
    this.#pair = null;
  }

  resume(
    budget: SourceMapSliceBudgetV1,
  ): CommandResultV1<SourceMapFallbackSliceResultV1> {
    if (this.#cancelled) return commandFailure("disposed");
    while (!budget.shouldYield()) {
      const next = this.#request.segments[this.#segmentIndex];
      if (next === undefined) {
        return commandSuccess(
          Object.freeze({ kind: "completed", offsetMap: this.#current }),
        );
      }
      if (this.#pair === null) {
        const admission = preflightPairComposition(
          this.#current,
          next,
          this.#request.scratchByteLimit,
        );
        if (!admission.ok) return admission;
        this.#pair = new PairComposition(
          this.#current,
          next,
          this.#request.scratchByteLimit,
        );
      }
      const progress = this.#pair.resume(budget);
      if (!progress.ok) return progress;
      if (progress.value.kind === "pending") return progress;
      this.#current = progress.value.offsetMap;
      this.#pair = null;
      this.#segmentIndex += 1;
    }
    return commandSuccess(Object.freeze({ kind: "pending" }));
  }
}

type PairPhase =
  "prefix-second" | "prefix-inverse" | "left" | "right" | "merge";

class PairComposition {
  readonly #first: SourceOffsetMapV1;
  readonly #second: SourceMapCompositionSegmentV1;
  readonly #prefixSecond: Float64Array;
  readonly #prefixInverse: Float64Array;
  readonly #left: SourceOffsetSpanV1[] = [];
  readonly #right: SourceOffsetSpanV1[] = [];
  readonly #result: SourceOffsetSpanV1[] = [];
  readonly #scratchLimit: number;
  #index = 0;
  #leftIndex = 0;
  #rightIndex = 0;
  #phase: PairPhase = "prefix-second";
  #scratchBytes: number;

  constructor(
    first: SourceOffsetMapV1,
    second: SourceMapCompositionSegmentV1,
    scratchLimit: number,
  ) {
    this.#first = first;
    this.#second = second;
    this.#prefixSecond = new Float64Array(second.offsetMap.spans.length + 1);
    this.#prefixInverse = new Float64Array(first.spans.length + 1);
    this.#scratchBytes =
      (this.#prefixSecond.length + this.#prefixInverse.length) * FLOAT64_BYTES;
    this.#scratchLimit = scratchLimit;
  }

  resume(
    budget: SourceMapSliceBudgetV1,
  ): CommandResultV1<SourceMapFallbackSliceResultV1> {
    if (this.#scratchBytes > this.#scratchLimit) {
      return commandFailure("resource-limit");
    }
    while (!budget.shouldYield()) {
      const progress = this.#processUnit();
      if (!progress.ok) return progress;
      if (progress.value !== null) return commandSuccess(progress.value);
    }
    return commandSuccess(Object.freeze({ kind: "pending" }));
  }

  #processUnit(): CommandResultV1<SourceMapFallbackSliceResultV1 | null> {
    if (this.#phase === "prefix-second") return this.#prefixSecondUnit();
    if (this.#phase === "prefix-inverse") return this.#prefixInverseUnit();
    if (this.#phase === "left") return this.#leftUnit();
    if (this.#phase === "right") return this.#rightUnit();
    return this.#mergeUnit();
  }

  #prefixSecondUnit(): CommandResultV1<null> {
    const span = this.#second.offsetMap.spans[this.#index];
    if (span === undefined) {
      this.#advancePhase("prefix-inverse");
      return commandSuccess(null);
    }
    this.#prefixSecond[this.#index + 1] =
      (this.#prefixSecond[this.#index] ?? 0) + spanDelta(span, false);
    this.#index += 1;
    return commandSuccess(null);
  }

  #prefixInverseUnit(): CommandResultV1<null> {
    const span = this.#first.spans[this.#index];
    if (span === undefined) {
      this.#advancePhase("left");
      return commandSuccess(null);
    }
    this.#prefixInverse[this.#index + 1] =
      (this.#prefixInverse[this.#index] ?? 0) + spanDelta(span, true);
    this.#index += 1;
    return commandSuccess(null);
  }

  #leftUnit(): CommandResultV1<null> {
    const span = this.#first.spans[this.#index];
    if (span === undefined) {
      this.#advancePhase("right");
      return commandSuccess(null);
    }
    const candidate = Object.freeze({
      newFromUtf16: mapBoundaryBinary(
        this.#second.offsetMap.spans,
        this.#prefixSecond,
        span.newFromUtf16,
        ASSOCIATION_BEFORE,
        false,
      ),
      newToUtf16: mapBoundaryBinary(
        this.#second.offsetMap.spans,
        this.#prefixSecond,
        span.newToUtf16,
        ASSOCIATION_AFTER,
        false,
      ),
      oldFromUtf16: span.oldFromUtf16,
      oldToUtf16: span.oldToUtf16,
    });
    this.#left.push(candidate);
    this.#admitScratch(candidate);
    this.#index += 1;
    return commandSuccess(null);
  }

  #rightUnit(): CommandResultV1<null> {
    const span = this.#second.offsetMap.spans[this.#index];
    if (span === undefined) {
      this.#advancePhase("merge");
      return commandSuccess(null);
    }
    const candidate = Object.freeze({
      newFromUtf16: span.newFromUtf16,
      newToUtf16: span.newToUtf16,
      oldFromUtf16: mapBoundaryBinary(
        this.#first.spans,
        this.#prefixInverse,
        span.oldFromUtf16,
        ASSOCIATION_BEFORE,
        true,
      ),
      oldToUtf16: mapBoundaryBinary(
        this.#first.spans,
        this.#prefixInverse,
        span.oldToUtf16,
        ASSOCIATION_AFTER,
        true,
      ),
    });
    this.#right.push(candidate);
    this.#admitScratch(candidate);
    this.#index += 1;
    return commandSuccess(null);
  }

  #mergeUnit(): CommandResultV1<SourceMapFallbackSliceResultV1 | null> {
    const candidate = this.#takeCandidate();
    if (candidate === undefined) {
      const offsetMap = Object.freeze({ spans: Object.freeze(this.#result) });
      return commandSuccess(Object.freeze({ kind: "completed", offsetMap }));
    }
    const prior = this.#result[this.#result.length - LAST_ITEM_OFFSET];
    if (prior === undefined || !spansTouch(prior, candidate)) {
      this.#result.push(candidate);
      return commandSuccess(null);
    }
    const merged = Object.freeze({
      newFromUtf16: Math.min(prior.newFromUtf16, candidate.newFromUtf16),
      newToUtf16: Math.max(prior.newToUtf16, candidate.newToUtf16),
      oldFromUtf16: Math.min(prior.oldFromUtf16, candidate.oldFromUtf16),
      oldToUtf16: Math.max(prior.oldToUtf16, candidate.oldToUtf16),
    });
    this.#result[this.#result.length - LAST_ITEM_OFFSET] = merged;
    this.#admitScratch(merged);
    return commandSuccess(null);
  }

  #takeCandidate(): SourceOffsetSpanV1 | undefined {
    const left = this.#left[this.#leftIndex];
    const right = this.#right[this.#rightIndex];
    if (left === undefined) {
      if (right !== undefined) this.#rightIndex += 1;
      return right;
    }
    if (right === undefined || compareSpans(left, right) <= 0) {
      this.#leftIndex += 1;
      return left;
    }
    this.#rightIndex += 1;
    return right;
  }

  #advancePhase(phase: PairPhase): void {
    this.#phase = phase;
    this.#index = 0;
  }

  #admitScratch(span: SourceOffsetSpanV1): void {
    this.#scratchBytes += encodedSpanScratchBytes(span);
  }
}

function normalizeSegments(
  values: readonly unknown[],
): CommandResultV1<readonly SourceMapCompositionSegmentV1[]> {
  if (!isClosedArray(values)) return commandFailure("invalid-command");
  const segments: SourceMapCompositionSegmentV1[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(values, index);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return commandFailure("invalid-command");
    }
    const segment = normalizeSegment(descriptor.value);
    if (!segment.ok) return segment;
    if (
      index > 0 &&
      segments[index - 1]?.replacementUtf16Length !==
        segment.value.priorUtf16Length
    ) {
      return commandFailure("stale-source");
    }
    segments.push(segment.value);
  }
  return commandSuccess(Object.freeze(segments));
}

function isClosedArray(values: readonly unknown[]): boolean {
  return (
    Object.getPrototypeOf(values) === Array.prototype &&
    Object.getOwnPropertySymbols(values).length === 0 &&
    Object.getOwnPropertyNames(values).length ===
      values.length + ARRAY_LENGTH_PROPERTY_COUNT
  );
}

function preflightPairComposition(
  first: SourceOffsetMapV1,
  second: SourceMapCompositionSegmentV1,
  scratchLimit: number,
): CommandResultV1<void> {
  const candidateCount = first.spans.length + second.offsetMap.spans.length;
  const prefixBytes = (candidateCount + PREFIX_SENTINEL_SLOTS) * FLOAT64_BYTES;
  if (
    candidateCount > SOURCE_COORDINATION_LIMITS_V1.maxChangedSpans ||
    prefixBytes > scratchLimit
  ) {
    return commandFailure("resource-limit");
  }
  return commandSuccess(undefined);
}

function normalizeSegment(
  value: unknown,
): CommandResultV1<SourceMapCompositionSegmentV1> {
  let record: Record<string, unknown>;
  try {
    record = closedRecord(
      value,
      ["offsetMap", "priorUtf16Length", "replacementUtf16Length"],
      "Source map composition segment",
    );
  } catch {
    return commandFailure("invalid-command");
  }
  if (
    !isSafeLength(record.priorUtf16Length) ||
    !isSafeLength(record.replacementUtf16Length)
  ) {
    return commandFailure("resource-limit");
  }
  const map = validateSourceOffsetMap(
    record.offsetMap,
    record.priorUtf16Length,
    record.replacementUtf16Length,
  );
  if (!map.ok) return map;
  return commandSuccess(
    Object.freeze({
      offsetMap: map.value,
      priorUtf16Length: record.priorUtf16Length,
      replacementUtf16Length: record.replacementUtf16Length,
    }),
  );
}

function mapBoundaryBinary(
  spans: readonly SourceOffsetSpanV1[],
  prefixDelta: Float64Array,
  offset: number,
  association: number,
  inverse: boolean,
): number {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = Math.floor((low + high) / BINARY_DIVISOR);
    const span = spans[middle];
    const to = inverse ? span?.newToUtf16 : span?.oldToUtf16;
    if (to !== undefined && to < offset) low = middle + 1;
    else high = middle;
  }
  const span = spans[low];
  const delta = prefixDelta[low] ?? 0;
  if (span === undefined) return offset + delta;
  const from = inverse ? span.newFromUtf16 : span.oldFromUtf16;
  if (offset < from) return offset + delta;
  if (inverse) {
    return association < 0 ? span.oldFromUtf16 : span.oldToUtf16;
  }
  return association < 0 ? span.newFromUtf16 : span.newToUtf16;
}

function spanDelta(span: SourceOffsetSpanV1, inverse: boolean): number {
  const oldLength = span.oldToUtf16 - span.oldFromUtf16;
  const newLength = span.newToUtf16 - span.newFromUtf16;
  return inverse ? oldLength - newLength : newLength - oldLength;
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

function compareSpans(
  left: SourceOffsetSpanV1,
  right: SourceOffsetSpanV1,
): number {
  return (
    left.oldFromUtf16 - right.oldFromUtf16 ||
    left.newFromUtf16 - right.newFromUtf16
  );
}

function encodedSpanScratchBytes(span: SourceOffsetSpanV1): number {
  return (
    SPAN_OBJECT_OVERHEAD_BYTES +
    String(span.newFromUtf16).length +
    String(span.newToUtf16).length +
    String(span.oldFromUtf16).length +
    String(span.oldToUtf16).length
  );
}

function isSafeLength(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
