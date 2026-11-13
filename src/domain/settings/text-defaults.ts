import { validateTextStyleValue } from "./text-style-values";
import type { SettingsDiagnostic, TextDefaultsV2 } from "./types";

export function loadTextDefaults(
  input: unknown,
  fallback: TextDefaultsV2,
  diagnostics: SettingsDiagnostic[],
): TextDefaultsV2 {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).length !== Object.keys(fallback).length ||
    Object.keys(fallback).some((key) => !(key in input))
  ) {
    diagnostics.push({ code: "settings.invalid-field", path: "toolDefaults.text" });
    return structuredClone(fallback);
  }
  const result = structuredClone(fallback);
  for (const key of Object.keys(fallback) as (keyof TextDefaultsV2)[]) {
    const candidate = (input as Record<string, unknown>)[key];
    const valid = validateTextStyleValue(key, candidate);
    if (!valid)
      diagnostics.push({ code: "settings.invalid-field", path: `toolDefaults.text.${key}` });
    const value = valid ? candidate : fallback[key];
    Object.assign(result, { [key]: value });
  }
  return result;
}
