export type SettingsScope = "vault" | "device-vault" | "file" | "session";

export const DEVICE_SETTINGS_STORAGE_KEY = "inkbook:device-settings:v2";
export const LEGACY_DEVICE_SETTINGS_STORAGE_KEY = "inkbook:device-settings:v1";

export const SETTINGS_SCOPE = Object.freeze({
  startupTool: "vault",
  toolDefaults: "vault",
  pageDefaults: "vault",
  filePlacement: "vault",
  fingerDrawingPreference: "device-vault",
  penTapInsertion: "device-vault",
  leftHandedToolbar: "device-vault",
  motion: "device-vault",
  keyboardShortcuts: "device-vault",
  background: "file",
  elementStyles: "file",
  currentTool: "session",
  currentToolValues: "session",
  fingerDrawingToggle: "session",
  zoom: "session",
  cameraPosition: "session",
} as const satisfies Record<string, SettingsScope>);
