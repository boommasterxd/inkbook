import type { App } from "obsidian";
import type { EditorChromeOpenings } from "../embeds/active-scene/editor-chrome-openings";
import type { InkbookSettingsStore } from "../settings/storage";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { openImageImportDialog } from "./image-import-dialog";

/** Binds each modal to its invoking window and current host preferences. */
export function createImageDialogOpenings(
  app: App,
  settings: InkbookSettingsStore,
  scheduler: (ownerWindow: Window | null) => WorkScheduler,
): Pick<EditorChromeOpenings, "onImportImages"> {
  const options = (signal: AbortSignal, ownerWindow: Window) => ({
    app,
    localization: settings.localization,
    scheduler: scheduler(ownerWindow),
    signal,
    readMotion: () => settings.getDeviceSettings().motion,
    observeMotion: (listener: () => void) => settings.subscribeDeviceSettings(listener),
  });
  return {
    onImportImages: (signal, ownerWindow, request) =>
      openImageImportDialog({ ...options(signal, ownerWindow), ...request }),
  };
}
