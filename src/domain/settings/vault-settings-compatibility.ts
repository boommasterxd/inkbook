import type { InkbookSettingsV4 } from "./types";
import { hasExactKeys, isRecord } from "./validation";

export const VAULT_SETTINGS_KEYS = [
  "version",
  "fontLibrary",
  "startupTool",
  "selectionHighlightsEnabled",
  "toolDefaults",
  "snapping",
  "holdToShape",
  "pageDefaults",
  "filePlacement",
  "refreshRatePreference",
] as const;

export const LEGACY_VAULT_SETTINGS_KEYS = VAULT_SETTINGS_KEYS.filter(
  (key) =>
    key !== "fontLibrary" &&
    key !== "snapping" &&
    key !== "selectionHighlightsEnabled" &&
    key !== "holdToShape",
);

/** Completes additive V4 preferences while retaining every explicitly persisted choice. */
export function addLegacySettingsDefaults(input: unknown, fallback: InkbookSettingsV4): unknown {
  if (!isRecord(input) || input.version !== 4) return input;
  const keys = [
    ...LEGACY_VAULT_SETTINGS_KEYS,
    ...("fontLibrary" in input ? ["fontLibrary"] : []),
    ...("snapping" in input ? ["snapping"] : []),
    ...("holdToShape" in input ? ["holdToShape"] : []),
    ...("selectionHighlightsEnabled" in input ? ["selectionHighlightsEnabled"] : []),
  ];
  if (!hasExactKeys(input, keys)) return input;
  return {
    fontLibrary: [],
    snapping: structuredClone(fallback.snapping),
    holdToShape: structuredClone(fallback.holdToShape),
    selectionHighlightsEnabled: fallback.selectionHighlightsEnabled,
    ...input,
    toolDefaults: addToolBehaviorDefaults(input.toolDefaults, fallback.toolDefaults),
  };
}

function addToolBehaviorDefaults(
  input: unknown,
  fallback: InkbookSettingsV4["toolDefaults"],
): unknown {
  if (!isRecord(input)) return input;
  return {
    text: structuredClone(fallback.text),
    line: structuredClone(fallback.line),
    ...input,
    pen: isRecord(input.pen)
      ? { holdToShapeEnabled: fallback.pen.holdToShapeEnabled, ...input.pen }
      : input.pen,
    arrow: isRecord(input.arrow)
      ? { snappingEnabled: fallback.arrow.snappingEnabled, ...input.arrow }
      : input.arrow,
  };
}
