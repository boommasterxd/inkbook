import {
  MarkdownView,
  normalizePath,
  Plugin,
  TFile,
  TFolder,
  type Editor,
  type MarkdownFileInfo,
} from "obsidian";

import {
  createObsidianInsertionController,
  createObsidianEmbedActions,
  createObsidianEmbedPasteController,
  createEmbedPasteExtension,
  createPenTapInsertionExtension,
  PenTapInsertionController,
  registerInkbookCommands,
  type CompletedEmptyLineInsertion,
  type EmbedPasteOutcome,
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
import { InkbookSettingsStore, InkbookSettingTab } from "./settings";
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
  let runtimeForSettings: ObsidianWorkspaceRuntime | undefined;
  const settingTab = addSettingsTab(plugin, settings, () => runtimeForSettings);
  const scheme = new ColorSchemeBroadcaster({
    getColorScheme: () => (plugin.app.isDarkMode() ? "dark" : "light"),
  });
  let layoutReady = false;
  let metadataResolved = false;
  plugin.registerEvent(
    plugin.app.metadataCache.on("changed", () => {
      metadataResolved = false;
    }),
  );
  plugin.registerEvent(
    plugin.app.metadataCache.on("resolved", () => {
      metadataResolved = true;
    }),
  );
  const embedActions = createObsidianEmbedActions(plugin.app, () => metadataResolved);
  const runtime = createWorkspaceRuntime(plugin, settings, scheme, embedActions, feedback);
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
  const penTap = new PenTapInsertionController(
    insertion,
    () => layoutReady && settings.getDeviceSettings().penTapInsertion === "handwriting",
  );
  const embedPaste = createObsidianEmbedPasteController(
    plugin.app,
    settings,
    createPlacementFeedback(plugin, feedback),
  );

  const lifecycle = new PresentationLifecycleRegistry();
  const { documentRecognition, ports } = createEmbedIntegration(plugin, lifecycle, scheme, runtime);
  plugin.app.workspace.onLayoutReady(() => {
    if (!active || !isActive()) return;
    layoutReady = true;
    registerVaultLifecycle(plugin, runtime, documentRecognition);
    registerMarkdownHistory(plugin, runtime);
    plugin.registerMarkdownPostProcessor(createReadingViewPostProcessor(ports));
    plugin.registerEditorExtension([
      createLivePreviewExtension(ports),
      createPenTapInsertionExtension(penTap),
      createEmbedPasteExtension(embedPaste, (outcome) => {
        const code = feedbackForEmbedPaste(outcome);
        if (code !== undefined) showGlobalFeedback(plugin, feedback, code);
      }),
    ]);
  });
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
  registerInkbookCommands(plugin, runtime, {
    canInsert: (editor, sourcePath) => layoutReady && insertion.canInsert(editor, sourcePath),
    request: (editor, sourcePath) => layoutReady && insertion.request(editor, sourcePath),
  });
  return () => {
    active = false;
    lifecycle.disposeAll();
    documentRecognition.dispose();
    runtime.dispose();
    feedback.dispose();
    scheme.clear();
    unregisterIcons();
  };
}

function addSettingsTab(
  plugin: Plugin,
  settings: InkbookSettingsStore,
  getRuntime: () => ObsidianWorkspaceRuntime | undefined,
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
  );
  plugin.addSettingTab(settingTab);
  return settingTab;
}

function createWorkspaceRuntime(
  plugin: Plugin,
  settings: InkbookSettingsStore,
  scheme: ColorSchemeBroadcaster,
  embedActions: ReturnType<typeof createObsidianEmbedActions>,
  feedback: InkbookFeedbackManager,
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
      fallbackOwnerWindow: () =>
        plugin.app.workspace.containerEl.ownerDocument.defaultView ?? undefined,
      manager: feedback,
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
  const documentRecognition = new ObsidianInkbookDocumentRecognition(plugin.app.vault);
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
