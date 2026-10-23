import { FILE_SCHEMA_LIMITS } from "../../../domain/schema/constants";
import { decodeStrokeSamplesSteps } from "./stroke-sample-codec";
import type { ParsedJsonProof } from "../../../domain/schema/parsed-json-proof";
import type { StrokeSampleEncodingCache } from "./stroke-sample-encoding-cache";

interface CompactSnapshotOptions {
  readonly proof?: ParsedJsonProof;
  readonly sampleEncodingCache?: StrokeSampleEncodingCache;
}

/** Mutates only the parser-owned disk stroke strings; the structural proof keeps its root identity. */
export function* decodeCompactSnapshotSteps(
  value: unknown,
  signal?: AbortSignal,
  options: CompactSnapshotOptions = {},
): Generator<void> {
  if (!isRecord(value) || !Array.isArray(value.elements)) return;
  if (value.elements.length > FILE_SCHEMA_LIMITS.elements) invalidCompactSnapshot();
  let remainingPoints = FILE_SCHEMA_LIMITS.strokePoints;
  let strokes = 0;
  for (const element of value.elements) {
    signal?.throwIfAborted();
    if (isRecord(element) && element.kind === "stroke") {
      strokes += 1;
      if (strokes > FILE_SCHEMA_LIMITS.strokes || typeof element.points !== "string") {
        invalidCompactSnapshot();
      }
      const encoding = element.points;
      const points = yield* decodeStrokeSamplesSteps(
        encoding,
        signal,
        remainingPoints,
        options.proof,
      );
      remainingPoints -= points.length / 3;
      element.points = points;
      if (typeof element.id === "string") {
        options.sampleEncodingCache?.retainDecoded(element.id, points, encoding);
      }
    }
    yield;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidCompactSnapshot(): never {
  throw new RangeError("Invalid compact snapshot resources or stroke encoding.");
}
