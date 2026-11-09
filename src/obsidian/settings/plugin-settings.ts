import { normalizePath, TFolder, type Plugin } from "obsidian";
import { FRAME_WORK_SHARE } from "../../domain/scheduling/work-scheduler";
import type { ObsidianWorkspaceRuntime } from "../embeds";
import { createObsidianInkImportPorts } from "../import/adapter";
import { createInkImportConverter } from "../import/convert";
import { ObsidianInkImportService } from "../import/service";
import { ObsidianVaultFolderAdapter } from "../vault";
import { InkImportAccess } from "./import/import-access";
import { InkbookSettingTab } from "./setting-tab";
import type { InkbookSettingsStore } from "./storage";

export function addPluginSettingsTab(
  plugin: Plugin,
  settings: InkbookSettingsStore,
  getRuntime: () => ObsidianWorkspaceRuntime | undefined,
  signal: AbortSignal,
): InkbookSettingTab {
  const workScheduler = (ownerWindow: Window | null) => {
    const runtime = getRuntime();
    if (runtime === undefined) throw new Error("Settings require an active workspace runtime.");
    return runtime.refreshRateProfiles.workScheduler(ownerWindow);
  };
  const createService = (ownerWindow: Window): ObsidianInkImportService => {
    const scheduler = workScheduler(ownerWindow);
    const createId = () => ownerWindow.crypto.randomUUID();
    const ports = createObsidianInkImportPorts({
      app: plugin.app,
      workScheduler: scheduler,
      createRunId: createId,
      convert: createInkImportConverter({
        ownerWindow,
        workScheduler: scheduler,
        createId,
        timestamp: () => Date.now(),
        frameIntervalMilliseconds: () => scheduler.budgetMs() / FRAME_WORK_SHARE,
        subscribeSchedulingProfile: (listener) =>
          getRuntime()?.refreshRateProfiles.subscribe(listener) ?? (() => undefined),
      }),
    });
    return new ObsidianInkImportService(ports);
  };
  const inkImport = new InkImportAccess({
    localization: settings.localization,
    app: plugin.app,
    createService,
    workScheduler,
    readMotion: () => settings.getDeviceSettings().motion,
    observeMotion: (listener) => settings.subscribeDeviceSettings(listener),
    signal,
  });
  const tab = new InkbookSettingTab(
    plugin.app,
    plugin,
    settings,
    new ObsidianVaultFolderAdapter(plugin.app.vault, TFolder, normalizePath),
    () =>
      getRuntime()?.refreshRateProfiles.status(
        plugin.app.workspace.containerEl.ownerDocument.defaultView,
      ),
    { lifetime: signal, workScheduler, inkImport },
  );
  plugin.addSettingTab(tab);
  return tab;
}
