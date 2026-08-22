import type { BackgroundTypeV1, InkbookSettingsV1, StartupToolV1, ToolDefaultsV1 } from "./types";

interface SettingsValue<T> {
  readonly present: true;
  readonly value: T;
}

interface MissingSettingsValue {
  readonly present: false;
}

export type OptionalSettingsValue<T> = SettingsValue<T> | MissingSettingsValue;

export interface EditorSettingsSession {
  currentTool: StartupToolV1;
  toolValues: ToolDefaultsV1;
  fingerDrawingEnabled: boolean;
}

export interface NewFilePageSettings {
  readonly background:
    | { readonly type: "none" }
    | {
        readonly type: Exclude<BackgroundTypeV1, "none">;
        readonly spacing: 20 | 40 | 50 | 60 | 80 | 100 | 150 | 200;
      };
  readonly writingLineHeight: number;
  readonly activeBufferLines: number;
  readonly lockedBufferLines: 0 | 1;
}

export function initializeEditorSettingsSession(
  settings: InkbookSettingsV1,
): EditorSettingsSession {
  return {
    currentTool: settings.startupTool,
    toolValues: structuredClone(settings.toolDefaults),
    fingerDrawingEnabled: false,
  };
}

export function resolveSettingPrecedence<T>(
  explicitSelection: OptionalSettingsValue<T>,
  session: OptionalSettingsValue<T>,
  vault: OptionalSettingsValue<T>,
  builtIn: T,
): T {
  if (explicitSelection.present) return explicitSelection.value;
  if (session.present) return session.value;
  if (vault.present) return vault.value;
  return builtIn;
}

export function createPageSettings(settings: InkbookSettingsV1): NewFilePageSettings {
  const defaults = settings.pageDefaults;
  const type = defaults.backgroundType;
  const background =
    type === "none"
      ? ({ type } as const)
      : ({ type, spacing: defaults.backgroundSpacing[type] } as const);
  return {
    background,
    writingLineHeight: defaults.writingLineHeight,
    activeBufferLines: defaults.activeBufferLines,
    lockedBufferLines: defaults.lockedBufferLines,
  };
}
