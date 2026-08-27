import type {
  InkbookSettingsV1,
  InkbookSettingsV2,
  SettingsDiagnostic,
  SettingsLoadResult,
} from "./types";
import { isRecord } from "./validation";

interface VersionedValue {
  readonly version: unknown;
}

function isVersionedValue(value: unknown): value is VersionedValue {
  return typeof value === "object" && value !== null && "version" in value;
}

/** Routes persisted data through the settings schema version boundary without mutating it. */
export function migrateSettingsToV1(input: unknown): SettingsLoadResult<unknown> {
  if (!isVersionedValue(input)) {
    return { value: input, diagnostics: [] };
  }
  if (input.version === 1) {
    return { value: input, diagnostics: [] };
  }

  const diagnostic: SettingsDiagnostic = {
    code: "settings.unsupported-version",
    path: "version",
  };
  return { value: undefined, diagnostics: [diagnostic] };
}

/** Adds the refresh-rate preference while preserving every version-one vault setting. */
function migrateVaultSettingsToV2(input: unknown): SettingsLoadResult<unknown> {
  if (!isVersionedValue(input)) return { value: input, diagnostics: [] };
  if (input.version === 2) return { value: input, diagnostics: [] };
  if (input.version === 1) {
    const previous = input as InkbookSettingsV1;
    const migrated: InkbookSettingsV2 = {
      ...previous,
      version: 2,
      refreshRatePreference: "auto",
    };
    return {
      value: migrated,
      diagnostics: [],
    };
  }
  return {
    value: undefined,
    diagnostics: [{ code: "settings.unsupported-version", path: "version" }],
  };
}

const LEGACY_LINE_SPACINGS = new Map<number, 25 | 33.333333333333336 | 50 | 100>([
  [50, 25],
  [100, 33.333333333333336],
  [150, 50],
  [200, 100],
]);

const LEGACY_PATTERN_SPACINGS = new Map<number, 25 | 33.333333333333336 | 50 | 100>([
  [20, 25],
  [40, 33.333333333333336],
  [60, 50],
  [80, 100],
]);

function migratedSpacing(value: unknown, values: ReadonlyMap<number, number>): unknown {
  return typeof value === "number" ? (values.get(value) ?? value) : value;
}

/** Reinterprets the former independent spacing scales as one shared absolute size series. */
export function migrateVaultSettingsToV3(input: unknown): SettingsLoadResult<unknown> {
  if (!isVersionedValue(input)) return { value: input, diagnostics: [] };
  if (input.version === 3) return { value: input, diagnostics: [] };
  const versionTwo = migrateVaultSettingsToV2(input);
  if (versionTwo.diagnostics.length > 0) return versionTwo;
  const previous = versionTwo.value;
  if (!isRecord(previous)) return versionTwo;
  const pageDefaults = previous.pageDefaults;
  if (!isRecord(pageDefaults)) {
    return { value: { ...previous, version: 3 }, diagnostics: [] };
  }
  const backgroundSpacing = pageDefaults.backgroundSpacing;
  if (!isRecord(backgroundSpacing)) {
    return {
      value: { ...previous, version: 3, pageDefaults: { ...pageDefaults } },
      diagnostics: [],
    };
  }
  const migrated = {
    ...previous,
    version: 3,
    pageDefaults: {
      backgroundType: pageDefaults.backgroundType,
      backgroundSpacing: {
        ...backgroundSpacing,
        lines: migratedSpacing(backgroundSpacing.lines, LEGACY_LINE_SPACINGS),
        dots: migratedSpacing(backgroundSpacing.dots, LEGACY_PATTERN_SPACINGS),
        squares: migratedSpacing(backgroundSpacing.squares, LEGACY_PATTERN_SPACINGS),
      },
      activeBufferLines: pageDefaults.activeBufferLines,
      lockedBufferLines: pageDefaults.lockedBufferLines,
    },
  };
  return { value: migrated, diagnostics: [] };
}
