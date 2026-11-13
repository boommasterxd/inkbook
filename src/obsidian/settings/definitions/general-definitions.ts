import {
  createEnglishLocalization,
  type MessageKey,
  type Translator,
} from "../../../domain/localization";
import type { SettingDefinition, SettingDefinitionGroup } from "obsidian";

import { STARTUP_TOOLS, validateCustomVaultFolderPath } from "../../../domain/settings";
import type { SettingsControlKey } from "../control-values";
import {
  dropdown,
  resetAction,
  sentenceCaseLabel,
  settingsAction,
  toggle,
} from "./definition-helpers";

const OPTION_KEYS = {
  select: "settings.options.select",
  eraser: "settings.options.eraser",
  draw: "settings.options.draw",
  text: "settings.options.text",
  highlighter: "settings.options.highlighter",
  "straight-highlighter": "settings.options.straight-highlighter",
  line: "settings.options.line",
  arrow: "settings.options.arrow",
  rectangle: "settings.options.rectangle",
  ellipse: "settings.options.ellipse",
  triangle: "settings.options.triangle",
  star: "settings.options.star",
  octagon: "settings.options.octagon",
  parallelogram: "settings.options.parallelogram",
  diamond: "settings.options.diamond",
  "coordinate-system": "settings.options.coordinate-system",
  table: "settings.options.table",
  system: "settings.options.system",
  full: "settings.options.full",
  reduced: "settings.options.reduced",
} as const satisfies Readonly<Record<string, MessageKey>>;

function createLabels(
  values: readonly string[],
  t: Translator = createEnglishLocalization().t,
): Record<string, string> {
  return Object.fromEntries(
    values.map((value) => {
      const key = OPTION_KEYS[value as keyof typeof OPTION_KEYS];
      return [value, key === undefined ? sentenceCaseLabel(value) : t(key)];
    }),
  );
}
function customFolderDefinition(
  isCustomFolder: () => boolean,
  t: Translator,
): SettingDefinition<SettingsControlKey> {
  return {
    name: t("settings.controls.customFolder"),
    desc: t("settings.controls.customFolderHelp"),
    visible: isCustomFolder,
    control: {
      type: "folder",
      key: "filePlacement.folder",
      placeholder: "Inkbook",
      validate: (value) => {
        const result = validateCustomVaultFolderPath(value);
        return result.valid ? undefined : t("settings.controls.customFolderInvalid");
      },
    },
  };
}

export interface GeneralGroupCallbacks {
  readonly t?: Translator;
  readonly isCustomFolder: () => boolean;
  readonly canCreateFolder: () => boolean;
  readonly createFolder: (element: HTMLElement) => void | Promise<void>;
  readonly reset: () => void | Promise<void>;
}

export function generalGroup(
  callbacks: GeneralGroupCallbacks,
): SettingDefinitionGroup<SettingsControlKey> {
  const t = callbacks.t ?? createEnglishLocalization().t;
  return {
    type: "group",
    heading: t("settings.general"),
    cls: "inkbook-settings-general-group",
    items: [
      dropdown(
        "startupTool",
        t("settings.controls.startupTool"),
        t("settings.controls.startupToolHelp"),
        createLabels(STARTUP_TOOLS, t),
      ),
      dropdown(
        "filePlacement.mode",
        t("settings.controls.filePlacement"),
        t("settings.controls.filePlacementHelp"),
        {
          "obsidian-attachment-folder": t("settings.controls.attachmentFolder"),
          "note-folder": t("settings.controls.noteFolder"),
          "custom-vault-folder": t("settings.controls.customFolder"),
        },
      ),
      customFolderDefinition(callbacks.isCustomFolder, t),
      {
        ...settingsAction(
          t("settings.controls.createFolder"),
          t("settings.controls.createFolderHelp"),
          undefined,
          callbacks.createFolder,
          t("settings.controls.createFolderFailed"),
        ),
        visible: callbacks.canCreateFolder,
      },
      toggle(
        "copyTextFieldsAsText",
        t("settings.controls.copyTextFieldsAsText"),
        t("settings.controls.copyTextFieldsAsTextHelp"),
      ),
      dropdown("device.language", t("settings.language"), t("settings.languageDescription"), {
        auto: t("settings.languageAuto"),
        de: "Deutsch",
        en: "English",
      }),
      toggle(
        "device.leftHandedToolbar",
        t("settings.leftHanded"),
        t("settings.leftHandedDescription"),
      ),
      dropdown("device.motion", t("settings.motion"), t("settings.motionDescription"), {
        system: t("settings.motion.system"),
        full: t("settings.motion.full"),
        reduced: t("settings.motion.reduced"),
      }),
      resetAction(t("settings.controls.resetGroup"), callbacks.reset, t),
    ],
  };
}

export { createLabels };
