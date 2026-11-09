import type { Plugin } from "obsidian";
import type { ObsidianWorkspaceRuntime } from "./embeds/workspace/workspace-runtime";
import { InkbookFeedbackManager, type InkbookFeedbackCode } from "./feedback";
import {
  createPenTapInsertionExtension,
  createInsertionContextMenuExtension,
  createEmbedPasteExtension,
  type PenTapInsertionController,
  type InsertionContextMenuController,
  type createObsidianEmbedPasteController,
  type EmbedPasteOutcome,
} from "./commands";
import { InkbookSettingsModalController, type InkbookSettingsStore } from "./settings";
import { addPluginSettingsTab } from "./settings/plugin-settings";
import { ColorSchemeBroadcaster } from "./theme/color-scheme";

/** Composes the plugin-owned interface with one settings and localization lifetime. */
export function createPluginInterface(
  plugin: Plugin,
  settings: InkbookSettingsStore,
  getRuntime: () => ObsidianWorkspaceRuntime | undefined,
  signal: AbortSignal,
) {
  const settingTab = addPluginSettingsTab(plugin, settings, getRuntime, signal);
  return {
    settingTab,
    settingsModal: new InkbookSettingsModalController(plugin.app, settingTab, settings),
    feedback: new InkbookFeedbackManager(
      {
        readMotion: () => settings.getDeviceSettings().motion,
        observeMotion: (listener) => settings.subscribeDeviceSettings(listener),
      },
      settings.localization,
    ),
    scheme: new ColorSchemeBroadcaster({
      getColorScheme: () => (plugin.app.isDarkMode() ? "dark" : "light"),
    }),
  };
}

export function registerInsertionExtensions(
  plugin: Plugin,
  controllers: {
    readonly penTap: PenTapInsertionController;
    readonly insertionMenu: InsertionContextMenuController;
    readonly embedPaste: ReturnType<typeof createObsidianEmbedPasteController>;
  },
  notify: (code: InkbookFeedbackCode) => void,
): void {
  plugin.registerEditorExtension([
    createPenTapInsertionExtension(controllers.penTap),
    createInsertionContextMenuExtension(controllers.insertionMenu),
    createEmbedPasteExtension(controllers.embedPaste, (outcome) => {
      const code = feedbackForEmbedPaste(outcome);
      if (code !== undefined) notify(code);
    }),
  ]);
}

function feedbackForEmbedPaste(outcome: EmbedPasteOutcome): InkbookFeedbackCode | undefined {
  if (outcome.kind === "failed") return "embed-paste-failed";
  if (outcome.kind !== "stale") return undefined;
  return outcome.cleanup === "failed" ? "embed-paste-cleanup-failed" : "embed-paste-note-changed";
}
