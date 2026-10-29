import { createBuiltInDeviceSettings, createBuiltInSettings } from "./defaults";
import { canonicalShortcutBinding, shortcutBindingSignature } from "./keyboard-shortcuts";
import { validateCustomVaultFolderPath } from "./path";
import {
  BACKGROUND_TYPES,
  CONFIGURABLE_SHORTCUT_ACTIONS,
  LINE_SPACINGS,
  MOTION_PREFERENCES,
  PEN_TAP_INSERTIONS,
  REFRESH_RATE_PREFERENCES,
  SHORTCUT_MODIFIERS,
  STARTUP_TOOLS,
  type FilePlacementV1,
  type InkbookDeviceSettingsV2,
  type InkbookSettingsV4,
  type KeyboardShortcutBindingV1,
  type KeyboardShortcutSettingsV1,
  type SettingsDiagnostic,
  type SettingsLoadResult,
  type SnappingSettingsV1,
} from "./types";
import {
  hasExactKeys,
  isIntegerInRange,
  isOneOf,
  isRecord,
  isScrollPreloadMarginPx,
  loadToolDefaults,
  validOrDefault,
} from "./validation";

function invalid(diagnostics: SettingsDiagnostic[], path: string): void {
  diagnostics.push({ code: "settings.invalid-field", path });
}

function loadBackgroundSpacing(
  input: unknown,
  fallback: InkbookSettingsV4["pageDefaults"]["backgroundSpacing"],
  diagnostics: SettingsDiagnostic[],
): InkbookSettingsV4["pageDefaults"]["backgroundSpacing"] {
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
      (value): value is typeof fallback.dots => isOneOf(value, LINE_SPACINGS),
      diagnostics,
      "pageDefaults.backgroundSpacing.dots",
    ),
    squares: validOrDefault(
      input.squares,
      fallback.squares,
      (value): value is typeof fallback.squares => isOneOf(value, LINE_SPACINGS),
      diagnostics,
      "pageDefaults.backgroundSpacing.squares",
    ),
  };
}

function loadPageDefaults(
  input: unknown,
  fallback: InkbookSettingsV4["pageDefaults"],
  diagnostics: SettingsDiagnostic[],
): InkbookSettingsV4["pageDefaults"] {
  const keys = ["backgroundType", "backgroundSpacing", "activeBufferLines", "lockedBufferLines"];
  if (!hasExactKeys(input, keys)) {
    invalid(diagnostics, "pageDefaults");
    return structuredClone(fallback);
  }

  return {
    backgroundType: validOrDefault(
      input.backgroundType,
      fallback.backgroundType,
      (value): value is InkbookSettingsV4["pageDefaults"]["backgroundType"] =>
        isOneOf(value, BACKGROUND_TYPES),
      diagnostics,
      "pageDefaults.backgroundType",
    ),
    backgroundSpacing: loadBackgroundSpacing(
      input.backgroundSpacing,
      fallback.backgroundSpacing,
      diagnostics,
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

function loadSnapping(
  input: unknown,
  fallback: SnappingSettingsV1,
  diagnostics: SettingsDiagnostic[],
): SnappingSettingsV1 {
  const keys = ["enabled", "angles", "bends", "connections", "structures"];
  if (!hasExactKeys(input, keys)) {
    invalid(diagnostics, "snapping");
    return structuredClone(fallback);
  }
  const booleanValue = (value: unknown): value is boolean => typeof value === "boolean";
  return {
    enabled: validOrDefault(
      input.enabled,
      fallback.enabled,
      booleanValue,
      diagnostics,
      "snapping.enabled",
    ),
    angles: validOrDefault(
      input.angles,
      fallback.angles,
      booleanValue,
      diagnostics,
      "snapping.angles",
    ),
    bends: validOrDefault(input.bends, fallback.bends, booleanValue, diagnostics, "snapping.bends"),
    connections: validOrDefault(
      input.connections,
      fallback.connections,
      booleanValue,
      diagnostics,
      "snapping.connections",
    ),
    structures: validOrDefault(
      input.structures,
      fallback.structures,
      booleanValue,
      diagnostics,
      "snapping.structures",
    ),
  };
}

function loadKeyboardShortcutBinding(
  input: unknown,
  fallback: KeyboardShortcutBindingV1 | null,
  diagnostics: SettingsDiagnostic[],
  path: string,
): KeyboardShortcutBindingV1 | null {
  if (input === null) return null;
  if (
    !hasExactKeys(input, ["key", "modifiers"]) ||
    typeof input.key !== "string" ||
    input.key.length === 0 ||
    input.key.length > 32 ||
    !Array.isArray(input.modifiers) ||
    input.modifiers.length > SHORTCUT_MODIFIERS.length ||
    !input.modifiers.every((modifier) => isOneOf(modifier, SHORTCUT_MODIFIERS)) ||
    new Set(input.modifiers).size !== input.modifiers.length
  ) {
    invalid(diagnostics, path);
    return structuredClone(fallback);
  }
  return canonicalShortcutBinding({
    key: input.key,
    modifiers: input.modifiers,
  });
}

function loadKeyboardShortcuts(
  input: unknown,
  fallback: KeyboardShortcutSettingsV1,
  diagnostics: SettingsDiagnostic[],
): KeyboardShortcutSettingsV1 {
  if (!hasExactKeys(input, CONFIGURABLE_SHORTCUT_ACTIONS)) {
    invalid(diagnostics, "keyboardShortcuts");
    return structuredClone(fallback);
  }
  const result = {} as Record<
    (typeof CONFIGURABLE_SHORTCUT_ACTIONS)[number],
    KeyboardShortcutBindingV1 | null
  >;
  const signatures = new Set<string>();
  for (const action of CONFIGURABLE_SHORTCUT_ACTIONS) {
    const path = `keyboardShortcuts.${action}`;
    const binding = loadKeyboardShortcutBinding(input[action], fallback[action], diagnostics, path);
    if (binding !== null && signatures.has(shortcutBindingSignature(binding))) {
      invalid(diagnostics, path);
      const fallbackBinding = fallback[action];
      result[action] =
        fallbackBinding !== null && !signatures.has(shortcutBindingSignature(fallbackBinding))
          ? structuredClone(fallbackBinding)
          : null;
      if (result[action] !== null) {
        signatures.add(shortcutBindingSignature(result[action]));
      }
      continue;
    }
    result[action] = binding;
    if (binding !== null) signatures.add(shortcutBindingSignature(binding));
  }
  return result;
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
): PreparedSettingsRoot<T> {
  const diagnostics: SettingsDiagnostic[] = [];
  if (isRecord(input) && "version" in input && input.version !== version) {
    diagnostics.push({ code: "settings.unsupported-version", path: "version" });
    return { valid: false, result: { value: fallback, diagnostics } };
  }
  if (!hasExactKeys(input, keys) || input.version !== version) {
    diagnostics.push({ code: "settings.invalid-root", path: "$" });
    return { valid: false, result: { value: fallback, diagnostics } };
  }
  return { valid: true, value: input, diagnostics };
}

const VAULT_SETTINGS_KEYS = [
  "version",
  "startupTool",
  "selectionHighlightsEnabled",
  "toolDefaults",
  "snapping",
  "pageDefaults",
  "filePlacement",
  "refreshRatePreference",
] as const;

const LEGACY_VAULT_SETTINGS_KEYS = VAULT_SETTINGS_KEYS.filter(
  (key) => key !== "snapping" && key !== "selectionHighlightsEnabled",
);

function addLegacySettingsDefaults(input: unknown, fallback: InkbookSettingsV4): unknown {
  if (!isRecord(input) || input.version !== 4) return input;
  const keys = [
    ...LEGACY_VAULT_SETTINGS_KEYS,
    ...("snapping" in input ? ["snapping"] : []),
    ...("selectionHighlightsEnabled" in input ? ["selectionHighlightsEnabled"] : []),
  ];
  if (!hasExactKeys(input, keys)) return input;
  return {
    snapping: structuredClone(fallback.snapping),
    selectionHighlightsEnabled: fallback.selectionHighlightsEnabled,
    ...input,
  };
}

function migrateV3Settings(
  input: unknown,
  fallback: InkbookSettingsV4,
):
  | { readonly kind: "input"; readonly migratedFromV3: boolean; readonly value: unknown }
  | { readonly kind: "failure"; readonly result: SettingsLoadResult<InkbookSettingsV4> } {
  if (!isRecord(input) || input.version !== 3) {
    return { kind: "input", migratedFromV3: false, value: input };
  }
  if (!hasExactKeys(input, LEGACY_VAULT_SETTINGS_KEYS)) {
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
      toolDefaults: isRecord(legacyDefaults)
        ? { ...legacyDefaults, select: structuredClone(fallback.toolDefaults.select) }
        : legacyDefaults,
    },
  };
}

export function loadSettings(input: unknown): SettingsLoadResult<InkbookSettingsV4> {
  const fallback = createBuiltInSettings();
  const migrated = migrateV3Settings(addLegacySettingsDefaults(input, fallback), fallback);
  if (migrated.kind === "failure") return migrated.result;
  const prepared = prepareSettingsRoot(migrated.value, fallback, VAULT_SETTINGS_KEYS, 4);
  if (!prepared.valid) return prepared.result;
  const { value, diagnostics } = prepared;

  const placement = loadFilePlacement(value.filePlacement, fallback.filePlacement, diagnostics);
  const result: SettingsLoadResult<InkbookSettingsV4> = {
    value: {
      version: 4,
      startupTool: validOrDefault(
        value.startupTool,
        fallback.startupTool,
        (value): value is InkbookSettingsV4["startupTool"] => isOneOf(value, STARTUP_TOOLS),
        diagnostics,
        "startupTool",
      ),
      selectionHighlightsEnabled: validOrDefault(
        value.selectionHighlightsEnabled,
        fallback.selectionHighlightsEnabled,
        (value): value is boolean => typeof value === "boolean",
        diagnostics,
        "selectionHighlightsEnabled",
      ),
      toolDefaults: loadToolDefaults(value.toolDefaults, fallback.toolDefaults, diagnostics),
      snapping: loadSnapping(value.snapping, fallback.snapping, diagnostics),
      pageDefaults: loadPageDefaults(value.pageDefaults, fallback.pageDefaults, diagnostics),
      filePlacement: placement,
      refreshRatePreference: validOrDefault(
        value.refreshRatePreference,
        fallback.refreshRatePreference,
        (value): value is InkbookSettingsV4["refreshRatePreference"] =>
          isOneOf(value, REFRESH_RATE_PREFERENCES),
        diagnostics,
        "refreshRatePreference",
      ),
    },
    diagnostics,
  };
  return migrated.migratedFromV3 && diagnostics.length > 0
    ? { value: fallback, diagnostics }
    : result;
}

const DEVICE_SETTINGS_V1_KEYS = [
  "version",
  "fingerDrawingEnabled",
  "penTapInsertion",
  "leftHandedToolbar",
  "motion",
] as const;

const LEGACY_DEVICE_SETTINGS_V2_KEYS = [...DEVICE_SETTINGS_V1_KEYS, "keyboardShortcuts"] as const;
const DEVICE_SETTINGS_V2_KEYS = [
  ...LEGACY_DEVICE_SETTINGS_V2_KEYS,
  "scrollPreloadMarginPx",
  "onboardingDismissed",
] as const;

function migrateDeviceSettingsV1(input: unknown, fallback: InkbookDeviceSettingsV2): unknown {
  return isRecord(input) && input.version === 1 && hasExactKeys(input, DEVICE_SETTINGS_V1_KEYS)
    ? {
        ...input,
        version: 2,
        onboardingDismissed: fallback.onboardingDismissed,
        keyboardShortcuts: structuredClone(fallback.keyboardShortcuts),
        scrollPreloadMarginPx: fallback.scrollPreloadMarginPx,
      }
    : input;
}

function addLegacyDeviceSettingsDefaults(
  input: unknown,
  fallback: InkbookDeviceSettingsV2,
): unknown {
  if (!isRecord(input) || input.version !== 2) return input;
  const keys = [
    ...LEGACY_DEVICE_SETTINGS_V2_KEYS,
    ...("scrollPreloadMarginPx" in input ? ["scrollPreloadMarginPx"] : []),
    ...("onboardingDismissed" in input ? ["onboardingDismissed"] : []),
  ];
  return hasExactKeys(input, keys)
    ? {
        scrollPreloadMarginPx: fallback.scrollPreloadMarginPx,
        onboardingDismissed: fallback.onboardingDismissed,
        ...input,
      }
    : input;
}

export function loadDeviceSettings(input: unknown): SettingsLoadResult<InkbookDeviceSettingsV2> {
  const fallback = createBuiltInDeviceSettings();
  const prepared = prepareSettingsRoot(
    addLegacyDeviceSettingsDefaults(migrateDeviceSettingsV1(input, fallback), fallback),
    fallback,
    DEVICE_SETTINGS_V2_KEYS,
    2,
  );
  if (!prepared.valid) return prepared.result;
  const { value, diagnostics } = prepared;

  const booleanValue = (value: unknown): value is boolean => typeof value === "boolean";
  return {
    value: {
      version: 2,
      onboardingDismissed: validOrDefault(
        value.onboardingDismissed,
        fallback.onboardingDismissed,
        booleanValue,
        diagnostics,
        "onboardingDismissed",
      ),
      scrollPreloadMarginPx: validOrDefault(
        value.scrollPreloadMarginPx,
        fallback.scrollPreloadMarginPx,
        isScrollPreloadMarginPx,
        diagnostics,
        "scrollPreloadMarginPx",
      ),
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
        (value): value is InkbookDeviceSettingsV2["penTapInsertion"] =>
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
        (value): value is InkbookDeviceSettingsV2["motion"] => isOneOf(value, MOTION_PREFERENCES),
        diagnostics,
        "motion",
      ),
      keyboardShortcuts: loadKeyboardShortcuts(
        value.keyboardShortcuts,
        fallback.keyboardShortcuts,
        diagnostics,
      ),
    },
    diagnostics,
  };
}
