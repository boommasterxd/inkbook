import type { SettingDefinition, SettingDefinitionRender } from "obsidian";

import type { SettingsControlKey } from "../control-values";
import { bindSettingsAction, type InkbookSettingActionTone } from "../settings-row";

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

export function settingsAction(
  name: string,
  desc: string,
  tone: InkbookSettingActionTone,
  activate: (element: HTMLElement) => void,
): SettingDefinitionRender {
  return {
    name,
    desc,
    render: (setting) =>
      bindSettingsAction(setting.settingEl, () => activate(setting.settingEl), tone),
  };
}

export function resetAction(name: string, activate: () => void): SettingDefinitionRender {
  return settingsAction(
    name,
    "Restore the built-in values without changing existing files or elements.",
    "caution",
    activate,
  );
}
