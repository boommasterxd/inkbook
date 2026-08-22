import type { SettingsDiagnostic, SettingsLoadResult } from "./types";

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
