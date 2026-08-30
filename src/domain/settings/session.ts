import type { BackgroundTypeV1, InkbookSettingsV4, StartupToolV1, ToolDefaultsV1 } from "./types";
import { CANONICAL_LOCKED_BUFFER_LINES } from "../schema/public";

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
        readonly spacing: 25 | 33.333333333333336 | 50 | 100;
      };
  readonly activeBufferLines: number;
  readonly lockedBufferLines: number;
}

export function initializeEditorSettingsSession(
  settings: InkbookSettingsV4,
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

export function createPageSettings(settings: InkbookSettingsV4): NewFilePageSettings {
  const defaults = settings.pageDefaults;
  const type = defaults.backgroundType;
  const background =
    type === "none"
      ? ({ type } as const)
      : ({ type, spacing: defaults.backgroundSpacing[type] } as const);
  return {
    background,
    activeBufferLines: defaults.activeBufferLines,
    lockedBufferLines: CANONICAL_LOCKED_BUFFER_LINES,
  };
}
