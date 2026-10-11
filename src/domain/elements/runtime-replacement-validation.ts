import {
  validateRuntimeInkElementV1,
  validateRuntimeInkElementV1Steps,
} from "../schema/element-validation";
import type { InkElementV1, StrokeElementV1 } from "../schema/types";
import type { ValidationResult } from "../schema/validation-types";
import {
  isStoredStroke,
  markValidatedInternalStyleReplacement,
  storedStrokeOffsetWithinRange,
} from "./stroke-replacement-proof";

/** A style draft may reuse field validation only while its owned source is current. */
export function validateInternalStyleReplacement(source: InkElementV1, replacement: InkElementV1) {
  const validation = validateRuntimeReplacement(source, replacement);
  if (
    validation.ok &&
    source.kind === "stroke" &&
    replacement.kind === "stroke" &&
    isStoredStroke(source) &&
    replacement.points === source.points
  ) {
    freezeStrokeHeader(source);
    freezeStrokeHeader(replacement);
    markValidatedInternalStyleReplacement(source, replacement);
  }
  return validation;
}

function freezeStrokeHeader(stroke: StrokeElementV1): void {
  Object.freeze(stroke.pivot);
  if (stroke.offset !== undefined) Object.freeze(stroke.offset);
  Object.freeze(stroke.style.color);
  Object.freeze(stroke.style);
  Object.freeze(stroke);
}

/** Reuse sample validation only for the exact exclusively owned stored buffer. */
export function validateRuntimeReplacement(source: object, replacement: InkElementV1) {
  const steps = validateRuntimeReplacementSteps(source, replacement, Infinity, Infinity);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Runtime composition supplies private candidates; only the exact owned samples reuse proof. */
export function* validateRuntimeReplacementSteps(
  source: object,
  replacement: InkElementV1,
  nodesPerStep = 2048,
  samplesPerStep = 256,
): Generator<boolean | void, ValidationResult<InkElementV1>> {
  if (
    isStoredStroke(source) &&
    "kind" in source &&
    source.kind === "stroke" &&
    "points" in source &&
    replacement.kind === "stroke" &&
    replacement.points === source.points
  ) {
    const header = { ...replacement, points: [0, 0, 0.5] };
    const validation = Number.isFinite(nodesPerStep)
      ? yield* validateRuntimeInkElementV1Steps(header, {}, nodesPerStep, samplesPerStep)
      : validateRuntimeInkElementV1(header);
    if (validation.ok && !storedStrokeOffsetWithinRange(replacement)) {
      return {
        ok: false as const,
        error: {
          code: "invalid-range" as const,
          path: "$.offset",
          message: "Translated stroke coordinates exceed the numeric limit.",
        },
      };
    }
    return validation.ok
      ? {
          ...validation,
          value: replacement,
          statistics: { ...validation.statistics, strokePoints: replacement.points.length / 3 },
        }
      : validation;
  }
  return Number.isFinite(nodesPerStep)
    ? yield* validateRuntimeInkElementV1Steps(replacement, {}, nodesPerStep, samplesPerStep)
    : validateRuntimeInkElementV1(replacement);
}
