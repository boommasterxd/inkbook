import type { SettingDefinition, SettingDefinitionGroup } from "obsidian";

import { STARTUP_TOOLS, validateCustomVaultFolderPath } from "../../../domain/settings";
import type { SettingsControlKey } from "../control-values";
import { dropdown, resetAction, sentenceCaseLabel } from "./definition-helpers";

const createLabels = (values: readonly string[]): Record<string, string> =>
  Object.fromEntries(values.map((value) => [value, sentenceCaseLabel(value)]));
function customFolderDefinition(
  isCustomFolder: () => boolean,
): SettingDefinition<SettingsControlKey> {
  return {
    name: "Custom vault folder",
    desc: "Enter a safe vault-relative folder for newly created Inkbook files.",
    visible: isCustomFolder,
    control: {
      type: "folder",
      key: "filePlacement.folder",
      placeholder: "Inkbook",
      validate: (value) => {
        const result = validateCustomVaultFolderPath(value);
        return result.valid
          ? undefined
          : "Enter a valid vault-relative folder without traversal segments.";
      },
    },
  };
}

export interface GeneralGroupCallbacks {
  readonly isCustomFolder: () => boolean;
  readonly canCreateFolder: () => boolean;
  readonly createFolder: (element: HTMLElement) => void;
  readonly reset: () => void;
}

export function generalGroup(
  callbacks: GeneralGroupCallbacks,
): SettingDefinitionGroup<SettingsControlKey> {
  return {
    type: "group",
    cls: "inkbook-settings-general-group",
    items: [
      dropdown(
        "startupTool",
        "Startup tool",
        "Choose the tool selected when an editor opens.",
        createLabels(STARTUP_TOOLS),
      ),
      dropdown(
        "filePlacement.mode",
        "File placement",
        "Choose where newly created Inkbook files are stored.",
        {
          "obsidian-attachment-folder": "Obsidian attachment folder",
          "note-folder": "Note folder",
          "custom-vault-folder": "Custom vault folder",
        },
      ),
      customFolderDefinition(callbacks.isCustomFolder),
      {
        name: "Create custom folder",
        desc: "Create the selected custom folder after explicit confirmation.",
        visible: callbacks.canCreateFolder,
        action: callbacks.createFolder,
      },
      resetAction("Reset group to defaults", callbacks.reset),
    ],
  };
}

export { createLabels };
