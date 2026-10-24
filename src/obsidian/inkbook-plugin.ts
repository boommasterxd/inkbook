import { createPhoneSheetHost } from "./menus/panels/phone-sheet-host";
import {
  registerDocumentStatusBar,
  resolveDocumentStatusPane,
} from "./runtime/document-status-bar-binding";
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
import { showHeadlessRecoveryNotice } from "./embeds/workspace/recovery-notice";

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
import type { MotionPreference } from "../rendering/motion/transitions";
import { ObsidianVaultFolderAdapter } from "./vault";

export async function activateInkbookPlugin(
  plugin: Plugin,
  isActive: () => boolean = () => true,
): Promise<(() => void) | undefined> {
  const settings = await loadSettings(plugin);
  if (!isActive()) return undefined;
  const unregisterIcons = registerInkbookIcons();
  const feedback = createFeedbackManager(settings);
  const lifetime = new AbortController();
  let runtimeForSettings: ObsidianWorkspaceRuntime | undefined;
  const workScheduler = schedulerFromRuntime(() => runtimeForSettings);
  const settingTab = addSettingsTab(plugin, settings, () => runtimeForSettings, lifetime.signal);
  const settingsModal = new InkbookSettingsModalController(plugin.app, settingTab, settings);
  const scheme = new ColorSchemeBroadcaster({
    getColorScheme: () => (plugin.app.isDarkMode() ? "dark" : "light"),
  });
  let layoutReady = false;
  const embedActions = createPluginEmbedActions(plugin, settings, workScheduler);
  plugin.register(() => embedActions.dispose());
  const runtime = createRuntime(plugin, settings, scheme, embedActions, feedback, settingsModal);
  runtimeForSettings = runtime;
  const disposeStatus = registerDocumentStatusBar(plugin, runtime, settings);
  const validationScheduling = documentOutputScheduling(runtime, workScheduler);
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
    validationScheduling,
  );
  const insertionCommand = registerInkbookCommands(plugin, runtime, {
    canInsert: (editor, sourcePath) => layoutReady && insertion.canInsert(editor, sourcePath),
    request: (editor, sourcePath) => layoutReady && insertion.request(editor, sourcePath),
  });
  const insertionMenu = registerInsertionMenu(
    plugin,
    insertionCommand,
    (editor, path, line) => layoutReady && insertion.canInsertAtLine(editor, path, line),
    workScheduler,
  );
  const penTap = new PenTapInsertionController(
    insertion,
    () => layoutReady && settings.getDeviceSettings().penTapInsertion === "handwriting",
    insertionCommand,
  );
  const lifecycle = new PresentationLifecycleRegistry();
  const integration = createEmbedIntegration(plugin, lifecycle, scheme, runtime, settings);
  const { documentRecognition, ports } = integration;
  const embedPaste = createObsidianEmbedPasteController(
    plugin.app,
    settings,
    createPlacementFeedback(plugin, feedback),
    lifetime.signal,
    documentRecognition,
    validationScheduling,
  );
  plugin.registerMarkdownPostProcessor(createReadingViewPostProcessor(ports));
  plugin.registerEditorExtension(createLivePreviewExtension(ports));
  plugin.app.workspace.onLayoutReady(() => {
    if (lifetime.signal.aborted || !isActive()) return;
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
  registerWorkspaceLifecycle(plugin, runtime, scheme, lifecycle);

  return () => {
    disposeStatus();
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

function schedulerFromRuntime(getRuntime: () => ObsidianWorkspaceRuntime | undefined) {
  return (ownerWindow: Window | null) => {
    const runtime = getRuntime();
    if (runtime === undefined) throw new Error("Workspace runtime is unavailable.");
    return runtime.refreshRateProfiles.workScheduler(ownerWindow);
  };
}

function documentOutputScheduling(
  runtime: ObsidianWorkspaceRuntime,
  workScheduler: ReturnType<typeof schedulerFromRuntime>,
) {
  return {
    workScheduler,
    subscribeSchedulingProfile: (listener: () => void) =>
      runtime.refreshRateProfiles.subscribe(listener),
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
    {
      lifetime: signal,
      workScheduler: (ownerWindow) => {
        const runtime = getRuntime();
        if (runtime === undefined) throw new Error("Settings require an active workspace runtime.");
        return runtime.refreshRateProfiles.workScheduler(ownerWindow);
      },
    },
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
  const runtime: ObsidianWorkspaceRuntime = new ObsidianWorkspaceRuntime(
    plugin.app.vault,
    plugin.app.fileManager,
    scheme,
    () => ({
      device: settings.getDeviceSettings(),
      vault: settings.getVaultSettings(),
    }),
    embedActions,
    {
      resolveDocumentStatusPane: (root) => resolveDocumentStatusPane(plugin.app.workspace, root),
      confirmEraseAll: (signal) =>
        confirmInkbookAction(plugin.app, {
          title: "Erase all elements?",
          description: "Remove every element from this drawing. You can undo this action.",
          confirmLabel: "Erase all",
          readMotion: () => settings.getDeviceSettings().motion,
          observeMotion: (listener) => settings.subscribeDeviceSettings(listener),
          workScheduler: (ownerWindow) => runtime.refreshRateProfiles.workScheduler(ownerWindow),
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
      onOpenSettings: (navigation) => settingsModal.open("settings", navigation),
      onOpenShortcuts: (navigation) => settingsModal.open("shortcuts", navigation),
    },
  );
  return runtime;
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
  settings: InkbookSettingsStore,
) {
  const documentRecognition = new ObsidianInkbookDocumentRecognition(plugin.app.vault, {
    deferUntilLayoutReady: true,
    workScheduler: (ownerWindow) => runtime.refreshRateProfiles.workScheduler(ownerWindow),
  });
  runtime.setSafeStaticProofProvider((documentId) =>
    documentRecognition.safeStaticProof(documentId),
  );
  runtime.setConfirmedOutputReceiver((documentId, output) => {
    if (output !== undefined)
      documentRecognition.acceptConfirmedOutput(
        documentId,
        output.content,
        output.outputHash,
        output.signature,
      );
  });
  return {
    documentRecognition,
    ports: {
      documents: documentRecognition,
      workScheduler: (ownerWindow: Window | null) =>
        runtime.refreshRateProfiles.workScheduler(ownerWindow),
      lifecycle,
      resolveDocument: createObsidianDocumentResolver(plugin.app),
      scheme,
      sessions: runtime,
      subscribeMotionPreference: (listener: (motion: MotionPreference) => void) =>
        settings.subscribeDeviceSettings((value) => listener(value.motion)),
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
    recognition.deferRefresh(file.path);
    runtime.handleVaultModification(file.path, (output) => {
      if (output === undefined) recognition.invalidate(file.path);
      else
        recognition.acceptConfirmedOutput(
          file.path,
          output.content,
          output.outputHash,
          output.signature,
        );
    });
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
  const ownerWindow = feedbackOwnerWindow(plugin);
  let releaseUndoHint = (): void => undefined;
  const inserted = feedback.showInWindow(ownerWindow, {
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
    onClosed: () => releaseUndoHint(),
    timeoutMs: 5_000,
  });
  releaseUndoHint = runtime.queueAutoActivation(
    insertion.filePath,
    ownerWindow,
    (retry) => {
      feedback.showInWindow(ownerWindow, {
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
  feedback.showInWindow(feedbackOwnerWindow(plugin), { code });
}

function feedbackOwnerWindow(plugin: Plugin): Window {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView)?.containerEl;
  const fallback = plugin.app.workspace.containerEl;
  const ownerWindow = (view ?? fallback).ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Inkbook feedback requires an owning window.");
  return ownerWindow;
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
  workScheduler: (
    ownerWindow: Window | null,
  ) => ReturnType<ObsidianWorkspaceRuntime["refreshRateProfiles"]["workScheduler"]>,
): InsertionContextMenuController {
  const controller = new InsertionContextMenuController(insertionCommand, canInsert, workScheduler);
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
  lifecycle: PresentationLifecycleRegistry,
): void {
  plugin.registerEvent(
    plugin.app.workspace.on("layout-change", () => lifecycle.refreshOwnerDocuments()),
  );
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

function createFeedbackManager(settings: InkbookSettingsStore): InkbookFeedbackManager {
  return new InkbookFeedbackManager({
    readMotion: () => settings.getDeviceSettings().motion,
    observeMotion: (listener) => settings.subscribeDeviceSettings(listener),
  });
}

function createPluginEmbedActions(
  plugin: Plugin,
  settings: InkbookSettingsStore,
  workScheduler: Parameters<typeof createObsidianEmbedActions>[3],
): ReturnType<typeof createObsidianEmbedActions> {
  return createObsidianEmbedActions(
    plugin.app,
    observeMetadataReadiness(plugin),
    () => settings.getDeviceSettings().motion,
    workScheduler,
    (listener) => settings.subscribeDeviceSettings(listener),
  );
}
