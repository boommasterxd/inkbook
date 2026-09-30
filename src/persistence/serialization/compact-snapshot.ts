import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";
import { decodeStrokeSamplesSteps } from "./stroke-sample-codec";

/** Mutates only the parser-owned disk stroke strings; the structural proof keeps its root identity. */
export function* decodeCompactSnapshotSteps(value: unknown, signal?: AbortSignal): Generator<void> {
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
      const points = yield* decodeStrokeSamplesSteps(element.points, signal, remainingPoints);
      remainingPoints -= points.length / 3;
      element.points = points;
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
