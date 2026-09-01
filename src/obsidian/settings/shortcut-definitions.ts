import type { Setting, SettingDefinitionGroup } from "obsidian";

import type { SettingsControlKey } from "./control-values";
import type { ObsidianHotkeyAccess } from "./obsidian-hotkey-conflicts";
import { ShortcutSettingsView } from "./shortcut-view";
import type { InkbookSettingsStore } from "./storage";

export function shortcutGroup(
  store: InkbookSettingsStore,
  hostHotkeys?: ObsidianHotkeyAccess,
): SettingDefinitionGroup<SettingsControlKey> {
  return {
    type: "group",
    heading: "Shortcuts",
    cls: "inkbook-shortcuts-group",
    items: [
      {
        name: "Keyboard shortcuts",
        desc: "Configure device-local Inkbook shortcuts and review fixed system controls.",
        render: (setting) => {
          const view = mountShortcutSettingsView(setting, store, hostHotkeys);
          return () => view.dispose();
        },
      },
    ],
  };
}

export function mountShortcutSettingsView(
  setting: Setting,
  store: InkbookSettingsStore,
  hostHotkeys?: ObsidianHotkeyAccess,
): ShortcutSettingsView {
  setting.settingEl.classList.add("inkbook-shortcuts-setting-row");
  setting.settingEl.replaceChildren();
  return new ShortcutSettingsView(setting.settingEl.createDiv(), store, hostHotkeys);
}
