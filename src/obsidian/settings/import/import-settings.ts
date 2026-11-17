import type { SettingDefinitionGroup, SettingDefinitionRender } from "obsidian";

import type { SettingsControlKey } from "../control-values";
import { settingsAction, withSettingsActionFeedback } from "../definitions/definition-helpers";
import { ImportHistory, type ImportHistoryOptions } from "./import-history";

interface ImportSettingsOptions extends ImportHistoryOptions {
  readonly closeOwnerOnNoteOpen?: (() => void) | undefined;
}

export function importSettingsGroup(
  options: ImportSettingsOptions,
): SettingDefinitionGroup<SettingsControlKey> {
  return {
    type: "group",
    heading: options.localization.t("import.group"),
    cls: "inkbook-settings-import-group",
    items: [
      startImportAction(options),
      {
        name: options.localization.t("import.history"),
        desc: options.localization.t("import.historyDescription"),
        render: (setting) => new ImportHistory(setting, options).dispose,
      },
    ],
  };
}

function startImportAction(options: ImportSettingsOptions): SettingDefinitionRender {
  const name = options.localization.t("import.start");
  const desc = options.localization.t("import.startDescription");
  return {
    name,
    desc,
    render: (setting, group) => {
      const lifetime = new AbortController();
      const release = settingsAction(
        name,
        desc,
        undefined,
        withSettingsActionFeedback(
          (element) =>
            options.access.open(
              element.ownerDocument.defaultView,
              undefined,
              lifetime.signal,
              options.closeOwnerOnNoteOpen,
            ),
          options,
        ),
      ).render(setting, group);
      return () => {
        lifetime.abort();
        release?.();
      };
    },
  };
}
