import type { FontLibraryEntryV2, SettingsDiagnostic } from "./types";
import { hasExactKeys, isIntegerInRange, isRecord } from "./validation";
import { fontFacesOverlap } from "../text/font-face-matching";

export function loadFontLibrary(
  input: unknown,
  diagnostics: SettingsDiagnostic[],
): FontLibraryEntryV2[] {
  if (!Array.isArray(input) || input.length > 128) {
    diagnostics.push({ code: "settings.invalid-field", path: "fontLibrary" });
    return [];
  }
  const result: FontLibraryEntryV2[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of input.entries()) {
    if (!validFontEntry(entry)) {
      diagnostics.push({ code: "settings.invalid-field", path: `fontLibrary.${index}` });
      continue;
    }
    const key = entry.id;
    if (seen.has(key) || result.some((previous) => fontFacesOverlap(previous, entry))) {
      diagnostics.push({ code: "settings.invalid-field", path: `fontLibrary.${index}` });
      continue;
    }
    seen.add(key);
    result.push(structuredClone(entry));
  }
  return result;
}

function validFontEntry(input: unknown): input is FontLibraryEntryV2 {
  if (!isRecord(input)) return false;
  const keys = [
    "id",
    "path",
    "family",
    "displayName",
    "weight",
    "style",
    ...("license" in input ? ["license"] : []),
    ...("weightRange" in input ? ["weightRange"] : []),
  ];
  if (
    !hasExactKeys(input, keys) ||
    typeof input.id !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.id)
  )
    return false;
  const id = input.id;
  if (
    typeof input.family !== "string" ||
    !/^custom-[a-f0-9]{64}$/.test(input.family) ||
    typeof input.path !== "string" ||
    !["ttf", "otf", "woff", "woff2"].some(
      (extension) => input.path === `Inkbook Fonts/${id}.${extension}`,
    )
  )
    return false;
  if (!validDisplayName(input.displayName) || !isIntegerInRange(input.weight, 1, 1000))
    return false;
  if (input.style !== "normal" && input.style !== "italic") return false;
  if ("license" in input && (typeof input.license !== "string" || input.license.length > 16_384))
    return false;
  return !("weightRange" in input) || validWeightRange(input.weightRange, input.weight);
}

function validDisplayName(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 128 &&
    !value.includes("\u0000")
  );
}

function validWeightRange(value: unknown, weight: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isIntegerInRange(value[0], 1, weight) &&
    isIntegerInRange(value[1], weight, 1000)
  );
}
