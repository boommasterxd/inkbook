import type { SettingDefinition, SettingDefinitionAction } from "obsidian";

import type { SettingsControlKey } from "./control-values";

export const COLOR_OPTIONS = {
  "theme-text": "Theme text color",
  "#EF4444FF": "Red",
  "#F97316FF": "Orange",
  "#EAB308FF": "Yellow",
  "#22C55EFF": "Green",
  "#06B6D4FF": "Cyan",
  "#3B82F6FF": "Blue",
  "#8B5CF6FF": "Violet",
  "#EC4899FF": "Pink",
  "#6B7280FF": "Gray",
} as const;

export function sentenceCaseLabel(value: string): string {
  const words = value.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function dropdown(
  key: SettingsControlKey,
  name: string,
  desc: string,
  options: Record<string, string>,
): SettingDefinition<SettingsControlKey> {
  return { name, desc, control: { type: "dropdown", key, options } };
}

export function toggle(
  key: SettingsControlKey,
  name: string,
  desc: string,
): SettingDefinition<SettingsControlKey> {
  return { name, desc, control: { type: "toggle", key } };
}

export function slider(
  key: SettingsControlKey,
  name: string,
  desc: string,
  min: number,
  max: number,
  step: number,
): SettingDefinition<SettingsControlKey> {
  return { name, desc, control: { type: "slider", key, min, max, step } };
}

export function resetAction(name: string, action: () => void): SettingDefinitionAction {
  return {
    name,
    desc: "Restore the built-in values without changing existing files or elements.",
    action,
  };
}
