import { createBuiltInDeviceSettings, createBuiltInSettings } from "./defaults";
import { migrateSettingsToV1, migrateVaultSettingsToV2 } from "./migrations";
import { validateCustomVaultFolderPath } from "./path";
import {
  BACKGROUND_TYPES,
  LINE_SPACINGS,
  MOTION_PREFERENCES,
  PATTERN_SPACINGS,
  PEN_TAP_INSERTIONS,
  REFRESH_RATE_PREFERENCES,
  STARTUP_TOOLS,
  type FilePlacementV1,
  type InkbookDeviceSettingsV1,
  type InkbookSettingsV2,
  type SettingsDiagnostic,
  type SettingsLoadResult,
} from "./types";
import {
  hasExactKeys,
  isIntegerInRange,
  isOneOf,
  isRecord,
  loadToolDefaults,
  validOrDefault,
} from "./validation";

function invalid(diagnostics: SettingsDiagnostic[], path: string): void {
  diagnostics.push({ code: "settings.invalid-field", path });
}

function loadBackgroundSpacing(
  input: unknown,
  fallback: InkbookSettingsV2["pageDefaults"]["backgroundSpacing"],
  diagnostics: SettingsDiagnostic[],
): InkbookSettingsV2["pageDefaults"]["backgroundSpacing"] {
  if (!hasExactKeys(input, ["lines", "dots", "squares"])) {
    invalid(diagnostics, "pageDefaults.backgroundSpacing");
    return structuredClone(fallback);
  }
  return {
    lines: validOrDefault(
      input.lines,
      fallback.lines,
      (value): value is typeof fallback.lines => isOneOf(value, LINE_SPACINGS),
      diagnostics,
      "pageDefaults.backgroundSpacing.lines",
    ),
    dots: validOrDefault(
      input.dots,
      fallback.dots,
      (value): value is typeof fallback.dots => isOneOf(value, PATTERN_SPACINGS),
      diagnostics,
      "pageDefaults.backgroundSpacing.dots",
    ),
    squares: validOrDefault(
      input.squares,
      fallback.squares,
      (value): value is typeof fallback.squares => isOneOf(value, PATTERN_SPACINGS),
      diagnostics,
      "pageDefaults.backgroundSpacing.squares",
    ),
  };
}

function loadPageDefaults(
  input: unknown,
  fallback: InkbookSettingsV2["pageDefaults"],
  diagnostics: SettingsDiagnostic[],
): InkbookSettingsV2["pageDefaults"] {
  const keys = [
    "backgroundType",
    "backgroundSpacing",
    "writingLineHeight",
    "activeBufferLines",
    "lockedBufferLines",
  ];
  if (!hasExactKeys(input, keys)) {
    invalid(diagnostics, "pageDefaults");
    return structuredClone(fallback);
  }

  return {
    backgroundType: validOrDefault(
      input.backgroundType,
      fallback.backgroundType,
      (value): value is InkbookSettingsV2["pageDefaults"]["backgroundType"] =>
        isOneOf(value, BACKGROUND_TYPES),
      diagnostics,
      "pageDefaults.backgroundType",
    ),
    backgroundSpacing: loadBackgroundSpacing(
      input.backgroundSpacing,
      fallback.backgroundSpacing,
      diagnostics,
    ),
    writingLineHeight: validOrDefault(
      input.writingLineHeight,
      fallback.writingLineHeight,
      (value): value is number => isIntegerInRange(value, 50, 200),
      diagnostics,
      "pageDefaults.writingLineHeight",
    ),
    activeBufferLines: validOrDefault(
      input.activeBufferLines,
      fallback.activeBufferLines,
      (value): value is number => isIntegerInRange(value, 1, 8),
      diagnostics,
      "pageDefaults.activeBufferLines",
    ),
    lockedBufferLines: validOrDefault(
      input.lockedBufferLines,
      fallback.lockedBufferLines,
      (value): value is number => isIntegerInRange(value, 0, 8),
      diagnostics,
      "pageDefaults.lockedBufferLines",
    ),
  };
}

function loadFilePlacement(
  value: unknown,
  fallback: FilePlacementV1,
  diagnostics: SettingsDiagnostic[],
): FilePlacementV1 {
  if (!isRecord(value) || typeof value.mode !== "string") {
    invalid(diagnostics, "filePlacement");
    return structuredClone(fallback);
  }
  if (value.mode === "obsidian-attachment-folder" || value.mode === "note-folder") {
    if (hasExactKeys(value, ["mode"])) return { mode: value.mode };
  } else if (
    value.mode === "custom-vault-folder" &&
    hasExactKeys(value, ["mode", "folder"]) &&
    typeof value.folder === "string"
  ) {
    const result = validateCustomVaultFolderPath(value.folder);
    if (result.valid) return { mode: value.mode, folder: result.path };
  }
  invalid(diagnostics, "filePlacement");
  return structuredClone(fallback);
}

type PreparedSettingsRoot<T> =
  | {
      readonly valid: true;
      readonly value: Record<string, unknown>;
      diagnostics: SettingsDiagnostic[];
    }
  | { readonly valid: false; readonly result: SettingsLoadResult<T> };

function prepareSettingsRoot<T>(
  input: unknown,
  fallback: T,
  keys: readonly string[],
  version: number,
  migrate: (value: unknown) => SettingsLoadResult<unknown>,
): PreparedSettingsRoot<T> {
  const migrated = migrate(input);
  const diagnostics = [...migrated.diagnostics];
  if (diagnostics.length > 0) return { valid: false, result: { value: fallback, diagnostics } };
  if (!hasExactKeys(migrated.value, keys) || migrated.value.version !== version) {
    diagnostics.push({ code: "settings.invalid-root", path: "$" });
    return { valid: false, result: { value: fallback, diagnostics } };
  }
  return { valid: true, value: migrated.value, diagnostics };
}

export function loadSettings(input: unknown): SettingsLoadResult<InkbookSettingsV2> {
  const fallback = createBuiltInSettings();
  const prepared = prepareSettingsRoot(
    input,
    fallback,
    [
      "version",
      "startupTool",
      "toolDefaults",
      "pageDefaults",
      "filePlacement",
      "refreshRatePreference",
    ],
    2,
    migrateVaultSettingsToV2,
  );
  if (!prepared.valid) return prepared.result;
  const { value, diagnostics } = prepared;

  const placement = loadFilePlacement(value.filePlacement, fallback.filePlacement, diagnostics);
  return {
    value: {
      version: 2,
      startupTool: validOrDefault(
        value.startupTool,
        fallback.startupTool,
        (value): value is InkbookSettingsV2["startupTool"] => isOneOf(value, STARTUP_TOOLS),
        diagnostics,
        "startupTool",
      ),
      toolDefaults: loadToolDefaults(value.toolDefaults, fallback.toolDefaults, diagnostics),
      pageDefaults: loadPageDefaults(value.pageDefaults, fallback.pageDefaults, diagnostics),
      filePlacement: placement,
      refreshRatePreference: validOrDefault(
        value.refreshRatePreference,
        fallback.refreshRatePreference,
        (value): value is InkbookSettingsV2["refreshRatePreference"] =>
          isOneOf(value, REFRESH_RATE_PREFERENCES),
        diagnostics,
        "refreshRatePreference",
      ),
    },
    diagnostics,
  };
}

export function loadDeviceSettings(input: unknown): SettingsLoadResult<InkbookDeviceSettingsV1> {
  const fallback = createBuiltInDeviceSettings();
  const prepared = prepareSettingsRoot(
    input,
    fallback,
    ["version", "fingerDrawingEnabled", "penTapInsertion", "leftHandedToolbar", "motion"],
    1,
    migrateSettingsToV1,
  );
  if (!prepared.valid) return prepared.result;
  const { value, diagnostics } = prepared;

  const booleanValue = (value: unknown): value is boolean => typeof value === "boolean";
  return {
    value: {
      version: 1,
      fingerDrawingEnabled: validOrDefault(
        value.fingerDrawingEnabled,
        fallback.fingerDrawingEnabled,
        booleanValue,
        diagnostics,
        "fingerDrawingEnabled",
      ),
      penTapInsertion: validOrDefault(
        value.penTapInsertion,
        fallback.penTapInsertion,
        (value): value is InkbookDeviceSettingsV1["penTapInsertion"] =>
          isOneOf(value, PEN_TAP_INSERTIONS),
        diagnostics,
        "penTapInsertion",
      ),
      leftHandedToolbar: validOrDefault(
        value.leftHandedToolbar,
        fallback.leftHandedToolbar,
        booleanValue,
        diagnostics,
        "leftHandedToolbar",
      ),
      motion: validOrDefault(
        value.motion,
        fallback.motion,
        (value): value is InkbookDeviceSettingsV1["motion"] => isOneOf(value, MOTION_PREFERENCES),
        diagnostics,
        "motion",
      ),
    },
    diagnostics,
  };
}
