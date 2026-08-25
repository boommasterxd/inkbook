import {
  MarkdownView,
  normalizePath,
  Notice,
  Plugin,
  setIcon,
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
  let active = true;
  let runtimeForSettings: ObsidianWorkspaceRuntime | undefined;
  const settingTab = new InkbookSettingTab(
    plugin.app,
    plugin,
    settings,
    new ObsidianVaultFolderAdapter(plugin.app.vault, TFolder, normalizePath),
    () =>
      runtimeForSettings?.refreshRateProfiles.status(
        plugin.app.workspace.containerEl.ownerDocument.defaultView,
      ),
  );
  plugin.addSettingTab(settingTab);
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
  const runtime = new ObsidianWorkspaceRuntime(
    plugin.app.vault,
    plugin.app.fileManager,
    scheme,
    () => ({
      device: settings.getDeviceSettings(),
      vault: settings.getVaultSettings(),
    }),
    embedActions,
    () => plugin.app.workspace.containerEl.ownerDocument.defaultView ?? undefined,
  );
  runtimeForSettings = runtime;
  plugin.register(runtime.refreshRateProfiles.subscribe(() => settingTab.update()));
  registerSettingsSubscriptions(plugin, settings, runtime);
  const insertion = createObsidianInsertionController(plugin.app, settings, {
    failed: (message) => {
      new Notice(message);
    },
    inserted: (completed) => showInsertionNotice(runtime, completed),
  });
  const penTap = new PenTapInsertionController(
    insertion,
    () => layoutReady && settings.getDeviceSettings().penTapInsertion === "handwriting",
  );
  const embedPaste = createObsidianEmbedPasteController(plugin.app, settings);

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
      createEmbedPasteExtension(embedPaste),
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
    scheme.clear();
    unregisterIcons();
  };
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

function showInsertionNotice(
  runtime: ObsidianWorkspaceRuntime,
  insertion: CompletedEmptyLineInsertion,
): void {
  const notice = new Notice("Handwriting inserted. ", 5000);
  const undo = notice.messageEl.createEl("button", { text: "Undo" });
  undo.addEventListener(
    "click",
    () => {
      void insertion.undo().then((removed) => {
        if (removed) {
          runtime.abortAutoActivation(insertion.filePath);
          notice.hide();
        }
      });
    },
    { once: true },
  );
  const ownerWindow = notice.messageEl.ownerDocument.defaultView;
  if (ownerWindow === null) return;
  runtime.queueAutoActivation(
    insertion.filePath,
    ownerWindow,
    (retry) => {
      const retryNotice = new Notice("Handwriting was inserted but the editor is not ready. ");
      retryNotice.messageEl.classList.add("inkbook-root");
      const retryButton = retryNotice.messageEl.createEl("button", {
        attr: { "aria-label": "Retry editor activation", title: "Retry editor activation" },
        cls: "inkbook-notice-icon-button",
      });
      const retryIcon = retryButton.createSpan({ cls: "inkbook-notice-action-icon" });
      setIcon(retryIcon, "rotate-ccw");
      retryButton.addEventListener(
        "click",
        () => {
          retryNotice.hide();
          retry();
        },
        { once: true },
      );
    },
    () => notice.hide(),
  );
}

function resolveEditorPane(
  editor: Editor,
  info: MarkdownView | MarkdownFileInfo,
): HTMLElement | undefined {
  return info instanceof MarkdownView && info.editor === editor ? info.containerEl : undefined;
}
