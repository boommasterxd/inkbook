import type { Keymap, Setting, SettingDefinitionGroup } from "obsidian";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";

import type { SettingsControlKey } from "../control-values";
import type { ObsidianHotkeyAccess } from "./obsidian-hotkey-conflicts";
import { ShortcutSettingsView } from "./shortcut-view";
import type { InkbookSettingsStore } from "../storage";
import type { SettingsViewState } from "../settings-view-state";

export function shortcutGroup(
  store: InkbookSettingsStore,
  keymap: Pick<Keymap, "pushScope" | "popScope">,
  hostHotkeys?: ObsidianHotkeyAccess,
  workScheduler?: (ownerWindow: Window | null) => WorkScheduler,
  viewState?: SettingsViewState,
): SettingDefinitionGroup<SettingsControlKey> {
  return {
    type: "group",
    heading: store.localization.t("settings.shortcuts.heading"),
    cls: "inkbook-shortcuts-group",
    items: [
      {
        name: store.localization.t("settings.shortcuts.keyboard"),
        desc: store.localization.t("settings.shortcuts.keyboardHelp"),
        render: (setting) => {
          const view = mountShortcutSettingsView(
            setting,
            store,
            keymap,
            hostHotkeys,
            workScheduler,
            viewState,
          );
          return () => view.dispose();
        },
      },
    ],
  };
}

export function mountShortcutSettingsView(
  setting: Setting,
  store: InkbookSettingsStore,
  keymap: Pick<Keymap, "pushScope" | "popScope">,
  hostHotkeys?: ObsidianHotkeyAccess,
  workScheduler?: (ownerWindow: Window | null) => WorkScheduler,
  viewState?: SettingsViewState,
): ShortcutSettingsView {
  setting.settingEl.classList.add("inkbook-shortcuts-setting-row");
  setting.settingEl.replaceChildren();
  return new ShortcutSettingsView(
    setting.settingEl.createDiv(),
    store,
    keymap,
    hostHotkeys,
    workScheduler,
    viewState,
  );
}
