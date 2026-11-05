import type { HoldToShapeSettingsV1, SettingsDiagnostic } from "./types";
import { hasExactKeys, isIntegerInRange, validOrDefault } from "./validation";

export function loadHoldToShapeSettings(
  input: unknown,
  fallback: HoldToShapeSettingsV1,
  diagnostics: SettingsDiagnostic[],
): HoldToShapeSettingsV1 {
  if (!hasExactKeys(input, ["enabled", "holdDurationMs", "jitterTolerancePx"])) {
    diagnostics.push({ code: "settings.invalid-field", path: "holdToShape" });
    return structuredClone(fallback);
  }
  return {
    enabled: validOrDefault(
      input.enabled,
      fallback.enabled,
      (value): value is boolean => typeof value === "boolean",
      diagnostics,
      "holdToShape.enabled",
    ),
    holdDurationMs: validOrDefault(
      input.holdDurationMs,
      fallback.holdDurationMs,
      (value): value is number => isIntegerInRange(value, 200, 2000),
      diagnostics,
      "holdToShape.holdDurationMs",
    ),
    jitterTolerancePx: validOrDefault(
      input.jitterTolerancePx,
      fallback.jitterTolerancePx,
      (value): value is number => isIntegerInRange(value, 1, 32),
      diagnostics,
      "holdToShape.jitterTolerancePx",
    ),
  };
}
