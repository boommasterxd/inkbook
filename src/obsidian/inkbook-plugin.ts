import { registerVaultLifecycle } from "./runtime/vault-lifecycle";
import { ReadingMarkdownIndex } from "./embeds/reading-markdown-index";
import { createPhoneSheetHost } from "./menus/panels/phone-sheet-host";
import { OnboardingPreference } from "./settings/onboarding-preference";
import { readMarkdownExportSource } from "./embeds/export/markdown-export-source";
import { ExportGeometryCache } from "./embeds/export/export-geometry-cache";
import { NativePdfOptionsGateway } from "./embeds/export/native-pdf-options";
import {
  registerDocumentStatusBar,
  resolveDocumentStatusPane,
} from "./runtime/document-status-bar-binding";
import {
  MarkdownRenderer,
  MarkdownView,
  Plugin,
  getLanguage,
  type Editor,
  type MarkdownFileInfo,
  type MarkdownRenderChild,
} from "obsidian";

import { confirmInkbookAction } from "./dialogs/action-dialog";
import { showHeadlessRecoveryNotice } from "./embeds/workspace/recovery-notice";

import {
  InsertionContextMenuController,
  createObsidianInsertionController,
  createObsidianEmbedActions,
  createObsidianEmbedPasteController,
  PenTapInsertionController,
  registerInkbookCommands,
  type CompletedEmptyLineInsertion,
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
import type { InkbookFeedbackManager, InkbookFeedbackCode } from "./feedback";
import { InkbookSettingsStore, type InkbookSettingsModalController } from "./settings";
import type { ColorSchemeBroadcaster } from "./theme/color-scheme";
import { createPluginInterface, registerInsertionExtensions } from "./plugin-interface";

export async function activateInkbookPlugin(
  plugin: Plugin,
  isActive: () => boolean = () => true,
): Promise<(() => void) | undefined> {
  const settings = await loadSettings(plugin);
  if (!isActive()) return undefined;
  const unregisterIcons = registerInkbookIcons();
  const lifetime = new AbortController();
  let runtimeForSettings: ObsidianWorkspaceRuntime | undefined;
  const workScheduler = schedulerFromRuntime(() => runtimeForSettings);
  const { settingTab, settingsModal, scheme, feedback } = createPluginInterface(
    plugin,
    settings,
    () => runtimeForSettings,
    lifetime.signal,
  );
  let layoutReady = false;
  const embedActions = createPluginEmbedActions(plugin, settings, workScheduler);
  plugin.register(() => embedActions.dispose());
  const runtime = createRuntime(plugin, settings, scheme, embedActions, feedback, settingsModal);
  runtimeForSettings = runtime;
  const disposeStatus = registerDocumentStatusBar(plugin, runtime, settings, settings.localization);
  const validationScheduling = documentOutputScheduling(runtime, workScheduler);
  plugin.register(runtime.refreshRateProfiles.subscribe(() => settingTab.update()));
  registerSettingsSubscriptions(plugin, settings, runtime);
  const insertion = createObsidianInsertionController(
    plugin.app,
    settings,
    {
      failed: (code) => showGlobalFeedback(plugin, feedback, code),
      inserted: (completed) => showInsertionFeedback(plugin, feedback, runtime, completed),
    },
    createPlacementFeedback(plugin, feedback),
    validationScheduling,
  );
  const insertionCommand = registerInsertionCommands(
    plugin,
    runtime,
    insertion,
    () => layoutReady,
    settings.localization,
  );
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
  const integration = createEmbedIntegration(
    plugin,
    lifecycle,
    scheme,
    runtime,
    settings.localization,
  );
  const { documentRecognition, ports } = integration;
  const embedPaste = createObsidianEmbedPasteController(
    plugin.app,
    settings,
    createPlacementFeedback(plugin, feedback),
    lifetime.signal,
    documentRecognition,
    { ...validationScheduling, localization: settings.localization },
  );
  const readingMarkdownIndex = new ReadingMarkdownIndex();
  plugin.registerMarkdownPostProcessor(createReadingViewPostProcessor(ports, readingMarkdownIndex));
  plugin.registerEditorExtension(createLivePreviewExtension(ports));
  plugin.app.workspace.onLayoutReady(() => {
    if (lifetime.signal.aborted || !isActive()) return;
    layoutReady = true;
    registerVaultLifecycle(plugin, runtime, documentRecognition);
    registerMarkdownHistory(plugin, runtime);
    documentRecognition.markLayoutReady();
    registerInsertionExtensions(plugin, { penTap, insertionMenu, embedPaste }, (code) =>
      showGlobalFeedback(plugin, feedback, code),
    );
  });
  registerWorkspaceLifecycle(plugin, runtime, scheme, lifecycle);

  return () => {
    disposeStatus();
    lifetime.abort();
    embedActions.dispose();
    lifecycle.disposeAll();
    readingMarkdownIndex.clear();
    integration.dispose();
    runtime.dispose();
    feedback.dispose();
    settingsModal.dispose();
    scheme.clear();
    unregisterIcons();
  };
}

function registerInsertionCommands(
  plugin: Plugin,
  runtime: ObsidianWorkspaceRuntime,
  insertion: ReturnType<typeof createObsidianInsertionController>,
  ready: () => boolean,
  localization: InkbookSettingsStore["localization"],
): InkbookInsertionCommand {
  return registerInkbookCommands(
    plugin,
    runtime,
    {
      canInsert: (editor, sourcePath) => ready() && insertion.canInsert(editor, sourcePath),
      request: (editor, sourcePath) => ready() && insertion.request(editor, sourcePath),
    },
    localization,
  );
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
      localization: settings.localization,
      resolveDocumentStatusPane: (root) => resolveDocumentStatusPane(plugin.app.workspace, root),
      confirmEraseAll: (signal) =>
        confirmInkbookAction(plugin.app, {
          localization: settings.localization,
          title: () => settings.localization.t("presentation.erase.title"),
          description: () => settings.localization.t("presentation.erase.description"),
          confirmLabel: () => settings.localization.t("presentation.erase.confirm"),
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
        showHeadlessRecoveryNotice(
          plugin.app,
          actions,
          () => settings.getDeviceSettings().motion,
          settings.localization,
          (ownerWindow) => runtime.refreshRateProfiles.workScheduler(ownerWindow),
        ),
      onOpenSettings: (navigation) => settingsModal.open("settings", navigation),
      onOpenShortcuts: (navigation) => settingsModal.open("shortcuts", navigation),
      onboardingPreference: new OnboardingPreference(settings),
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
  localization: InkbookSettingsStore["localization"],
) {
  const exportGeometryCache = new ExportGeometryCache();
  const nativePdfOptions = new NativePdfOptionsGateway(plugin.app);
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
    dispose: () => {
      exportGeometryCache.dispose();
      nativePdfOptions.dispose();
      documentRecognition.dispose();
    },
    documentRecognition,
    ports: {
      localization,
      bindNativePdfOptions: (root: HTMLElement, sourcePath: string) =>
        nativePdfOptions.bind(root, sourcePath),
      exportGeometryCache,
      acquireSchedulingProfile: (owner: MarkdownRenderChild) => {
        const document = owner.containerEl.ownerDocument;
        const key = `inkbook-export-${crypto.randomUUID()}`;
        runtime.refreshRateProfiles.acquire(key, document.defaultView, document);
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          runtime.refreshRateProfiles.release(key);
        };
        owner.register(release);
        return release;
      },
      renderExportLabel: (label: string, target: HTMLElement, owner: MarkdownRenderChild) =>
        MarkdownRenderer.render(plugin.app, label, target, "", owner),
      readMarkdownSource: (sourcePath: string) => readMarkdownExportSource(plugin.app, sourcePath),
      prepareStaticExport: (documentId: string) => runtime.prepareStaticExport(documentId),
      documents: documentRecognition,
      workScheduler: (ownerWindow: Window | null) =>
        runtime.refreshRateProfiles.workScheduler(ownerWindow),
      subscribeSchedulingProfile: (listener: () => void) =>
        runtime.refreshRateProfiles.subscribe(listener),
      lifecycle,
      resolveDocument: createObsidianDocumentResolver(plugin.app),
      scheme,
      sessions: runtime,
    },
  };
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
  settings.localization.setLanguage(settings.getDeviceSettings().language, getLanguage());
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
      if (runtime.hasUnsavedChanges()) tasks.add(() => runtime.prepareForQuit());
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
    settings.localization,
  );
}
