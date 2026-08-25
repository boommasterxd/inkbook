import type { SettingDefinition, SettingDefinitionGroup, SettingDefinitionPage } from "obsidian";

import {
  BACKGROUND_TYPES,
  LINE_SPACINGS,
  PATTERN_SPACINGS,
  REFRESH_RATE_PREFERENCES,
  STARTUP_TOOLS,
  validateCustomVaultFolderPath,
} from "../../domain/settings";
import type { RefreshRateProfileStatus } from "../performance";
import type { SettingsControlKey } from "./control-values";
import { dropdown, resetAction, sentenceCaseLabel, slider } from "./definition-helpers";

const labels = (values: readonly string[]): Record<string, string> =>
  Object.fromEntries(values.map((value) => [value, sentenceCaseLabel(value)]));
const numberLabels = (values: readonly number[]): Record<string, string> =>
  Object.fromEntries(values.map((value) => [String(value), String(value)]));

function backgroundPage(): SettingDefinitionPage<SettingsControlKey> {
  return {
    type: "page",
    name: "Background",
    desc: "Configure the background copied into newly created files.",
    items: [
      dropdown(
        "pageDefaults.backgroundType",
        "Background type",
        "Choose the background for newly created files.",
        labels(BACKGROUND_TYPES),
      ),
      dropdown(
        "pageDefaults.backgroundSpacing.lines",
        "Line spacing",
        "Choose the line spacing copied into new files.",
        numberLabels(LINE_SPACINGS),
      ),
      dropdown(
        "pageDefaults.backgroundSpacing.dots",
        "Dot spacing",
        "Choose the dot spacing copied into new files.",
        numberLabels(PATTERN_SPACINGS),
      ),
      dropdown(
        "pageDefaults.backgroundSpacing.squares",
        "Square spacing",
        "Choose the square spacing copied into new files.",
        numberLabels(PATTERN_SPACINGS),
      ),
    ],
  };
}

function pageBufferPage(): SettingDefinitionPage<SettingsControlKey> {
  return {
    type: "page",
    name: "Page buffer",
    desc: "Configure page dimensions copied into newly created files.",
    items: [
      slider(
        "pageDefaults.writingLineHeight",
        "Writing line height",
        "Set the writing line height in new files.",
        50,
        200,
        10,
      ),
      slider(
        "pageDefaults.activeBufferLines",
        "Active buffer lines",
        "Set the active buffer in new files.",
        1,
        8,
        1,
      ),
    ],
  };
}

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
  readonly refreshRateStatus: () => RefreshRateProfileStatus;
  readonly reset: () => void;
}

export function generalGroup(
  callbacks: GeneralGroupCallbacks,
): SettingDefinitionGroup<SettingsControlKey> {
  return {
    type: "group",
    items: [
      dropdown(
        "startupTool",
        "Startup tool",
        "Choose the tool selected when an editor opens.",
        labels(STARTUP_TOOLS),
      ),
      dropdown(
        "refreshRatePreference",
        "Display refresh rate",
        refreshRateDescription(callbacks.refreshRateStatus()),
        Object.fromEntries(
          REFRESH_RATE_PREFERENCES.map((value) => [
            String(value),
            value === "auto" ? autoRefreshRateLabel(callbacks.refreshRateStatus()) : `${value} Hz`,
          ]),
        ),
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
      backgroundPage(),
      pageBufferPage(),
      resetAction("Reset group to defaults", callbacks.reset),
    ],
  };
}

function autoRefreshRateLabel(status: RefreshRateProfileStatus): string {
  if (status.kind === "detected") return `Auto (detected: ${status.refreshRate} Hz)`;
  if (status.kind === "detecting") return "Auto (detecting…)";
  return "Auto";
}

function refreshRateDescription(status: RefreshRateProfileStatus): string {
  if (status.kind === "detected") {
    return `Detected ${status.refreshRate} Hz for this Obsidian window. Other windows are measured independently.`;
  }
  if (status.kind === "detecting") {
    return "Detecting this Obsidian window. Inkbook uses the 120 Hz profile until detection completes.";
  }
  return "Use quick per-window detection or select a fixed frame-rate profile.";
}

export { labels };
