import type { SettingDefinitionGroup, SettingDefinitionRender } from "obsidian";

import type { SettingsControlKey } from "../control-values";
import { settingsAction, withSettingsActionFeedback } from "../definitions/definition-helpers";
import { ImportHistory, type ImportHistoryOptions } from "./import-history";

export function importSettingsGroup(
  options: ImportHistoryOptions,
): SettingDefinitionGroup<SettingsControlKey> {
  return {
    type: "group",
    heading: "Import",
    cls: "inkbook-settings-import-group",
    items: [
      startImportAction(options),
      {
        name: "Import history",
        desc: "Review previous imports, restore Obsidian Ink embeds or clean up originals.",
        render: (setting) => new ImportHistory(setting, options).dispose,
      },
    ],
  };
}

function startImportAction(options: ImportHistoryOptions): SettingDefinitionRender {
  const name = "Start import";
  const desc = "Convert Obsidian Ink handwriting into editable Inkbook files. Originals are kept.";
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
            options.access.open(element.ownerDocument.defaultView, undefined, lifetime.signal),
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
