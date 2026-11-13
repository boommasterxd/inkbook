import type { InkbookSettingsV4, SettingsLoadResult } from "./types";
import { hasExactKeys, isRecord } from "./validation";

export const VAULT_SETTINGS_KEYS = [
  "version",
  "copyTextFieldsAsText",
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
    key !== "copyTextFieldsAsText" &&
    key !== "snapping" &&
    key !== "selectionHighlightsEnabled" &&
    key !== "holdToShape",
);

/** Completes additive V4 preferences while retaining every explicitly persisted choice. */
export function addLegacySettingsDefaults(input: unknown, fallback: InkbookSettingsV4): unknown {
  if (!isRecord(input) || input.version !== 4) return input;
  const keys = [
    ...LEGACY_VAULT_SETTINGS_KEYS,
    ...("copyTextFieldsAsText" in input ? ["copyTextFieldsAsText"] : []),
    ...("fontLibrary" in input ? ["fontLibrary"] : []),
    ...("snapping" in input ? ["snapping"] : []),
    ...("holdToShape" in input ? ["holdToShape"] : []),
    ...("selectionHighlightsEnabled" in input ? ["selectionHighlightsEnabled"] : []),
  ];
  if (!hasExactKeys(input, keys)) return input;
  return {
    copyTextFieldsAsText: fallback.copyTextFieldsAsText,
    fontLibrary: [],
    snapping: structuredClone(fallback.snapping),
    holdToShape: structuredClone(fallback.holdToShape),
    selectionHighlightsEnabled: fallback.selectionHighlightsEnabled,
    ...input,
    toolDefaults: addToolBehaviorDefaults(input.toolDefaults, fallback.toolDefaults),
  };
}

export function migrateV3Settings(
  input: unknown,
  fallback: InkbookSettingsV4,
):
  | { readonly kind: "input"; readonly migratedFromV3: boolean; readonly value: unknown }
  | { readonly kind: "failure"; readonly result: SettingsLoadResult<InkbookSettingsV4> } {
  if (!isRecord(input) || input.version !== 3) {
    return { kind: "input", migratedFromV3: false, value: input };
  }
  if (
    !hasExactKeys(input, [
      ...LEGACY_VAULT_SETTINGS_KEYS,
      ...("fontLibrary" in input ? ["fontLibrary"] : []),
    ])
  ) {
    return {
      kind: "failure",
      result: {
        value: fallback,
        diagnostics: [{ code: "settings.invalid-root", path: "$" }],
      },
    };
  }
  const legacyDefaults = input.toolDefaults;
  if (isRecord(legacyDefaults) && Object.prototype.hasOwnProperty.call(legacyDefaults, "select")) {
    return {
      kind: "failure",
      result: {
        value: fallback,
        diagnostics: [{ code: "settings.invalid-field", path: "toolDefaults" }],
      },
    };
  }
  return {
    kind: "input",
    migratedFromV3: true,
    value: {
      ...input,
      version: 4,
      selectionHighlightsEnabled: fallback.selectionHighlightsEnabled,
      snapping: structuredClone(fallback.snapping),
      holdToShape: structuredClone(fallback.holdToShape),
      toolDefaults: isRecord(legacyDefaults)
        ? { ...legacyDefaults, select: structuredClone(fallback.toolDefaults.select) }
        : legacyDefaults,
    },
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
