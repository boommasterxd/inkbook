import { validateRuntimeInkElementV1 } from "../schema/element-validation";
import type { InkElementV1 } from "../schema/types";
import { isStoredStroke, storedStrokeOffsetWithinRange } from "./stroke-replacement-proof";

/** Reuse sample validation only for the exact exclusively owned stored buffer. */
export function validateRuntimeReplacement(source: object, replacement: InkElementV1) {
  if (
    isStoredStroke(source) &&
    "kind" in source &&
    source.kind === "stroke" &&
    "points" in source &&
    replacement.kind === "stroke" &&
    replacement.points === source.points
  ) {
    const validation = validateRuntimeInkElementV1({ ...replacement, points: [0, 0, 0.5] });
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
  return validateRuntimeInkElementV1(replacement);
}
