import { fonts as enFonts } from "./locales/en/fonts";
import { fonts as deFonts } from "./locales/de/fonts";
import { importWarnings as enImportWarnings } from "./locales/en/import-warnings";
import { importWarnings as deImportWarnings } from "./locales/de/import-warnings";
import { settingsControls as enSettingsControls } from "./locales/en/settings-controls";
import { settingsControls as deSettingsControls } from "./locales/de/settings-controls";
import { presentation as enPresentation } from "./locales/en/presentation";
import { presentation as dePresentation } from "./locales/de/presentation";
import { canvas as enCanvas } from "./locales/en/canvas";
import { canvas as deCanvas } from "./locales/de/canvas";
import { host as enHost } from "./locales/en/host";
import { host as deHost } from "./locales/de/host";
import { inkImport as enInkimport } from "./locales/en/import";
import { inkImport as deInkimport } from "./locales/de/import";
import { editor as enEditor } from "./locales/en/editor";
import { editor as deEditor } from "./locales/de/editor";
import { settings as enSettings } from "./locales/en/settings";
import { settings as deSettings } from "./locales/de/settings";

export const english = {
  ...enFonts,
  ...enSettings,
  ...enImportWarnings,
  ...enSettingsControls,
  ...enPresentation,
  ...enEditor,
  ...enInkimport,
  ...enHost,
  ...enCanvas,
} as const;
export type MessageKey = keyof typeof english;
export type MessageCatalog = Readonly<Record<MessageKey, string>>;
export const german: MessageCatalog = {
  ...deFonts,
  ...deSettings,
  ...deImportWarnings,
  ...deSettingsControls,
  ...dePresentation,
  ...deEditor,
  ...deInkimport,
  ...deHost,
  ...deCanvas,
};
