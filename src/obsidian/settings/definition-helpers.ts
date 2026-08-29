import type { SettingDefinition, SettingDefinitionAction } from "obsidian";

import type { SettingsControlKey } from "./control-values";

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

export function resetAction(name: string, action: () => void): SettingDefinitionAction {
  return {
    name,
    desc: "Restore the built-in values without changing existing files or elements.",
    action,
  };
}
