import { createPhoneSheetHost } from "./menus/phone-sheet-host";
import {
  MarkdownView,
  normalizePath,
  Plugin,
  TFile,
  TFolder,
  type Editor,
  type MarkdownFileInfo,
} from "obsidian";

import { confirmInkbookAction } from "./dialogs/action-dialog";
import { showHeadlessRecoveryNotice } from "./embeds/recovery-notice";

import {
  createInsertionContextMenuExtension,
  InsertionContextMenuController,
  createObsidianInsertionController,
  createObsidianEmbedActions,
  createObsidianEmbedPasteController,
  createEmbedPasteExtension,
  createPenTapInsertionExtension,
  PenTapInsertionController,
  registerInkbookCommands,
  type CompletedEmptyLineInsertion,
  type EmbedPasteOutcome,
  type InkbookInsertionCommand,
} from "./commands";
import {
  createLivePreviewExtension,
  createObsidianDocumentResolver,
  createReadingViewPostProcessor,
  ObsidianInkbookDocumentRecognition,
  ObsidianWorkspaceRuntime,
  PresentationLifecycleRegistry,
} from "./embeds";
import { registerInkbookIcons } from "./icons/inkbook-icons";
import { InkbookFeedbackManager, type InkbookFeedbackCode } from "./feedback";
import {
  InkbookSettingsModalController,
  InkbookSettingsStore,
  InkbookSettingTab,
} from "./settings";
import { ColorSchemeBroadcaster } from "./theme/color-scheme";
import { ObsidianVaultFolderAdapter } from "./vault";

export async function activateInkbookPlugin(
  plugin: Plugin,
  isActive: () => boolean = () => true,
): Promise<(() => void) | undefined> {
  const settings = await loadSettings(plugin);
  if (!isActive()) return undefined;
  const unregisterIcons = registerInkbookIcons();
  const feedback = new InkbookFeedbackManager();
  let active = true;
  const lifetime = new AbortController();
  let runtimeForSettings: ObsidianWorkspaceRuntime | undefined;
  const settingTab = addSettingsTab(plugin, settings, () => runtimeForSettings, lifetime.signal);
  const settingsModal = new InkbookSettingsModalController(plugin.app, settingTab, settings);
  const scheme = new ColorSchemeBroadcaster({
    getColorScheme: () => (plugin.app.isDarkMode() ? "dark" : "light"),
  });
  let layoutReady = false;
  const metadataResolved = observeMetadataReadiness(plugin);
  const embedActions = createObsidianEmbedActions(
    plugin.app,
    metadataResolved,
    () => settings.getDeviceSettings().motion,
  );
  plugin.register(() => embedActions.dispose());
  const runtime = createRuntime(plugin, settings, scheme, embedActions, feedback, settingsModal);
  runtimeForSettings = runtime;
  plugin.register(runtime.refreshRateProfiles.subscribe(() => settingTab.update()));
  registerSettingsSubscriptions(plugin, settings, runtime);
  const insertion = createObsidianInsertionController(
    plugin.app,
    settings,
    {
      failed: (code) => {
        showGlobalFeedback(plugin, feedback, code);
      },
      inserted: (completed) => showInsertionFeedback(plugin, feedback, runtime, completed),
    },
    createPlacementFeedback(plugin, feedback),
  );
  const insertionCommand = registerInkbookCommands(plugin, runtime, {
    canInsert: (editor, sourcePath) => layoutReady && insertion.canInsert(editor, sourcePath),
    request: (editor, sourcePath) => layoutReady && insertion.request(editor, sourcePath),
  });
  const insertionMenu = registerInsertionMenu(
    plugin,
    insertionCommand,
    (editor, path, line) => layoutReady && insertion.canInsertAtLine(editor, path, line),
  );
  const penTap = new PenTapInsertionController(
    insertion,
    () => layoutReady && settings.getDeviceSettings().penTapInsertion === "handwriting",
    insertionCommand,
  );
  const embedPaste = createObsidianEmbedPasteController(
    plugin.app,
    settings,
    createPlacementFeedback(plugin, feedback),
    lifetime.signal,
  );

  const lifecycle = new PresentationLifecycleRegistry();
  const { documentRecognition, ports } = createEmbedIntegration(plugin, lifecycle, scheme, runtime);
  plugin.registerMarkdownPostProcessor(createReadingViewPostProcessor(ports));
  plugin.registerEditorExtension(createLivePreviewExtension(ports));
  plugin.app.workspace.onLayoutReady(() => {
    if (!active || !isActive()) return;
    layoutReady = true;
    registerVaultLifecycle(plugin, runtime, documentRecognition);
    registerMarkdownHistory(plugin, runtime);
    documentRecognition.markLayoutReady();
    plugin.registerEditorExtension([
      createPenTapInsertionExtension(penTap),
      createInsertionContextMenuExtension(insertionMenu),
      createEmbedPasteExtension(embedPaste, (outcome) => {
        const code = feedbackForEmbedPaste(outcome);
        if (code !== undefined) showGlobalFeedback(plugin, feedback, code);
      }),
    ]);
  });
  registerWorkspaceLifecycle(plugin, runtime, scheme);

  return () => {
    active = false;
    lifetime.abort();
    embedActions.dispose();
    lifecycle.disposeAll();
    documentRecognition.dispose();
    runtime.dispose();
    feedback.dispose();
    settingsModal.dispose();
    scheme.clear();
    unregisterIcons();
  };
}

function addSettingsTab(
  plugin: Plugin,
  settings: InkbookSettingsStore,
  getRuntime: () => ObsidianWorkspaceRuntime | undefined,
  signal: AbortSignal,
): InkbookSettingTab {
  const settingTab = new InkbookSettingTab(
    plugin.app,
    plugin,
    settings,
    new ObsidianVaultFolderAdapter(plugin.app.vault, TFolder, normalizePath),
    () =>
      getRuntime()?.refreshRateProfiles.status(
        plugin.app.workspace.containerEl.ownerDocument.defaultView,
      ),
    signal,
  );
  plugin.addSettingTab(settingTab);
  return settingTab;
}

function createRuntime(
  plugin: Plugin,
  settings: InkbookSettingsStore,
  scheme: ColorSchemeBroadcaster,
  embedActions: ReturnType<typeof createObsidianEmbedActions>,
  feedback: InkbookFeedbackManager,
  settingsModal: InkbookSettingsModalController,
): ObsidianWorkspaceRuntime {
  return new ObsidianWorkspaceRuntime(
    plugin.app.vault,
    plugin.app.fileManager,
    scheme,
    () => ({
      device: settings.getDeviceSettings(),
      vault: settings.getVaultSettings(),
    }),
    embedActions,
    {
      confirmEraseAll: (signal) =>
        confirmInkbookAction(plugin.app, {
          title: "Erase all elements?",
          description: "Remove every element from this drawing. You can undo this action.",
          confirmLabel: "Erase all",
          readMotion: () => settings.getDeviceSettings().motion,
          destructive: true,
          signal,
        }),
      deviceStorage: {
        loadLocalStorage: (key) => {
          const stored: unknown = plugin.app.loadLocalStorage(key);
          return stored;
        },
        saveLocalStorage: (key, data) => plugin.app.saveLocalStorage(key, data),
      },
      fallbackOwnerWindow: () =>
        plugin.app.workspace.containerEl.ownerDocument.defaultView ?? undefined,
      keymap: plugin.app.keymap,
      createPhoneSheetHost: () => createPhoneSheetHost(plugin.app),
      manager: feedback,
      openRecovery: (actions) =>
        showHeadlessRecoveryNotice(plugin.app, actions, () => settings.getDeviceSettings().motion),
      onOpenSettings: () => settingsModal.open("settings"),
      onOpenShortcuts: () => settingsModal.open("shortcuts"),
      view: () => plugin.app.workspace.getActiveViewOfType(MarkdownView)?.containerEl,
    },
  );
}

function registerSettingsSubscriptions(
  plugin: Plugin,
  settings: InkbookSettingsStore,
  runtime: ObsidianWorkspaceRuntime,
): void {
  plugin.register(settings.subscribeDeviceSettings((value) => runtime.updateDeviceSettings(value)));
  plugin.register(settings.subscribeVaultSettings((value) => runtime.updateVaultSettings(value)));
}

function createEmbedIntegration(
  plugin: Plugin,
  lifecycle: PresentationLifecycleRegistry,
  scheme: ColorSchemeBroadcaster,
  runtime: ObsidianWorkspaceRuntime,
) {
  const documentRecognition = new ObsidianInkbookDocumentRecognition(plugin.app.vault, {
    deferUntilLayoutReady: true,
  });
  return {
    documentRecognition,
    ports: {
      documents: documentRecognition,
      lifecycle,
      resolveDocument: createObsidianDocumentResolver(plugin.app),
      scheme,
      sessions: runtime,
    },
  };
}

function registerVaultLifecycle(
  plugin: Plugin,
  runtime: ObsidianWorkspaceRuntime,
  recognition: ObsidianInkbookDocumentRecognition,
): void {
  const handleFileChange = (file: unknown): void => {
    if (!(file instanceof TFile)) return;
    recognition.invalidate(file.path);
    runtime.handleVaultModification(file.path);
  };
  plugin.registerEvent(plugin.app.vault.on("create", handleFileChange));
  plugin.registerEvent(plugin.app.vault.on("modify", handleFileChange));
}

async function loadSettings(plugin: Plugin): Promise<InkbookSettingsStore> {
  const settings = new InkbookSettingsStore(
    {
      loadData: () => plugin.loadData(),
      saveData: (data) => plugin.saveData(data),
    },
    {
      loadLocalStorage: (key) => {
        const stored: unknown = plugin.app.loadLocalStorage(key);
        return stored;
      },
      saveLocalStorage: (key, data) => plugin.app.saveLocalStorage(key, data),
    },
  );
  await settings.load();
  return settings;
}

function registerMarkdownHistory(plugin: Plugin, runtime: ObsidianWorkspaceRuntime): void {
  plugin.registerEvent(
    plugin.app.workspace.on("editor-change", (editor, info) => {
      const pane = resolveEditorPane(editor, info);
      const sourcePath = info.file?.path;
      if (pane !== undefined && sourcePath !== undefined) {
        runtime.handleMarkdownEditorChange(sourcePath, pane);
      }
    }),
  );
}

function showInsertionFeedback(
  plugin: Plugin,
  feedback: InkbookFeedbackManager,
  runtime: ObsidianWorkspaceRuntime,
  insertion: CompletedEmptyLineInsertion,
): void {
  const target = feedbackTarget(plugin);
  const inserted = feedback.showInViewOrWindow(target.ownerWindow, target.view, {
    actions: [
      {
        id: "undo-insertion",
        run: async () => {
          const removed = await insertion.undo();
          if (removed) runtime.abortAutoActivation(insertion.filePath);
          return removed;
        },
      },
    ],
    code: "handwriting-inserted",
    timeoutMs: 5_000,
  });
  runtime.queueAutoActivation(
    insertion.filePath,
    target.ownerWindow,
    (retry) => {
      feedback.showInViewOrWindow(target.ownerWindow, target.view, {
        actions: [
          { id: "retry-open", run: retry },
          { id: "dismiss", run: () => undefined },
        ],
        code: "editor-activation-delayed",
      });
    },
    () => inserted.close(),
  );
}

function showGlobalFeedback(
  plugin: Plugin,
  feedback: InkbookFeedbackManager,
  code: InkbookFeedbackCode,
): void {
  const target = feedbackTarget(plugin);
  feedback.showInViewOrWindow(target.ownerWindow, target.view, { code });
}

function feedbackTarget(plugin: Plugin): {
  readonly ownerWindow: Window;
  readonly view?: HTMLElement;
} {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView)?.containerEl;
  const fallback = plugin.app.workspace.containerEl;
  const ownerWindow = (view ?? fallback).ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Inkbook feedback requires an owning window.");
  return {
    ownerWindow,
    ...(view === undefined ? {} : { view }),
  };
}

function createPlacementFeedback(plugin: Plugin, feedback: InkbookFeedbackManager) {
  return { show: () => showGlobalFeedback(plugin, feedback, "placement-folder-fallback") };
}

function feedbackForEmbedPaste(outcome: EmbedPasteOutcome): InkbookFeedbackCode | undefined {
  if (outcome.kind === "failed") return "embed-paste-failed";
  if (outcome.kind !== "stale") return undefined;
  return outcome.cleanup === "failed" ? "embed-paste-cleanup-failed" : "embed-paste-note-changed";
}

function resolveEditorPane(
  editor: Editor,
  info: MarkdownView | MarkdownFileInfo,
): HTMLElement | undefined {
  return info instanceof MarkdownView && info.editor === editor ? info.containerEl : undefined;
}

function registerInsertionMenu(
  plugin: Plugin,
  insertionCommand: InkbookInsertionCommand,
  canInsert: (editor: Editor, path: string, line: number) => boolean,
): InsertionContextMenuController {
  const controller = new InsertionContextMenuController(insertionCommand, canInsert);
  plugin.register(() => controller.clear());
  plugin.registerEvent(
    plugin.app.workspace.on("editor-menu", (menu, editor, context) => {
      controller.addItem(menu, editor, context);
    }),
  );
  return controller;
}

function registerWorkspaceLifecycle(
  plugin: Plugin,
  runtime: ObsidianWorkspaceRuntime,
  scheme: ColorSchemeBroadcaster,
): void {
  plugin.registerEvent(
    plugin.app.workspace.on("quit", (tasks) => {
      tasks.add(() => runtime.prepareForQuit());
    }),
  );
  plugin.registerEvent(
    plugin.app.workspace.on("css-change", () => {
      scheme.refresh();
    }),
  );
}

function observeMetadataReadiness(plugin: Plugin): () => boolean {
  let resolved = false;
  plugin.registerEvent(
    plugin.app.metadataCache.on("changed", () => {
      resolved = false;
    }),
  );
  plugin.registerEvent(
    plugin.app.metadataCache.on("resolved", () => {
      resolved = true;
    }),
  );
  return () => resolved;
}
