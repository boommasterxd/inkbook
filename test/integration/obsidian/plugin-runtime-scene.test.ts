import { workSchedulerFromFrames } from "../../fixtures/obsidian/work-scheduler";
import { useAsyncWindowFrames } from "../../fixtures/obsidian/async-presentation-window";
import { Plugin, TFile, Tasks, type MarkdownRenderChild } from "obsidian";
import type { MarkdownSectionInformation } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
  createBuiltInDeviceSettings,
  createBuiltInSettings,
  type InkbookDeviceSettingsV2,
  type InkbookSettingsV4,
} from "../../../src/domain/settings";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-model-port";
import type { InkbookColorScheme } from "../../../src/obsidian/theme/color-scheme";
import { ColorSchemeBroadcaster } from "../../../src/obsidian/theme/color-scheme";
import { activateInkbookPlugin } from "../../../src/obsidian/inkbook-plugin";
import { ObsidianWorkspaceRuntime } from "../../../src/obsidian/embeds/workspace-runtime";
import type { PresentationAttachment } from "../../../src/obsidian/embeds/presentation-port";
import type { ActiveEditorViewState } from "../../../src/obsidian/embeds/active-editor/navigation";
import type { ObsidianEmbedActions } from "../../../src/obsidian/commands";
import { InkbookFeedbackManager } from "../../../src/obsidian/feedback";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import {
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
} from "../../../src/persistence/worker/runtime/public";
import { FakePresentationElement, inkbookRoot } from "../../fixtures/obsidian/presentation-dom";

class InkbookPlugin extends Plugin {
  #deactivate: (() => void) | undefined;
  override async onload(): Promise<void> {
    this.#deactivate = await activateInkbookPlugin(this);
  }

  override onunload(): void {
    this.#deactivate?.();
  }
}

interface CapturedSceneOptions {
  readonly deviceSettings: InkbookDeviceSettingsV2;
  readonly model: EditableDocumentModel;
  readonly onLock: () => void;
  readonly root: HTMLElement;
  readonly scheme: InkbookColorScheme;
  readonly startupTool: InkbookSettingsV4["startupTool"];
}

interface TestPluginRegistration {
  readonly postProcessors: Array<
    (
      element: HTMLElement,
      context: {
        addChild(child: MarkdownRenderChild): void;
        getSectionInfo(): MarkdownSectionInformation | null;
        readonly sourcePath: string;
      },
    ) => Promise<unknown> | void
  >;
  readonly settingTabs: Array<{
    setControlValue(key: string, value: unknown): Promise<void>;
  }>;
  settingsData: unknown;
}

const scenes = vi.hoisted(() => ({
  readiness: Promise.resolve(true),
  records: [] as Array<{
    readonly dispose: ReturnType<typeof vi.fn>;
    readonly finishLock: ReturnType<typeof vi.fn>;
    readonly updateDeviceSettings: ReturnType<typeof vi.fn>;
    readonly options: CapturedSceneOptions;
    readonly setScheme: ReturnType<typeof vi.fn>;
    viewState: ActiveEditorViewState | undefined;
  }>,
}));

vi.mock("../../../src/obsidian/embeds/active-scene", () => ({
  ActiveInkbookScene: class {
    readonly dispose = vi.fn();
    readonly finishLock = vi.fn(async () => undefined);
    readonly updateDeviceSettings = vi.fn();
    readonly ready = scenes.readiness;
    readonly setScheme = vi.fn();
    readonly #record: (typeof scenes.records)[number];

    public constructor(options: CapturedSceneOptions) {
      this.#record = {
        dispose: this.dispose,
        finishLock: this.finishLock,
        options,
        setScheme: this.setScheme,
        updateDeviceSettings: this.updateDeviceSettings,
        viewState: undefined,
      };
      scenes.records.push(this.#record);
    }

    public disableInput(): void {}
    public enableInput(): void {}
    public getViewState(): ActiveEditorViewState | undefined {
      return this.#record.viewState;
    }
    public executeAction(): void {}
    public isActionAvailable(): boolean {
      return true;
    }
  },
}));

const TestTFile = TFile as unknown as new (path: string, size: number) => TFile;

function serializedDocument(): { readonly bytes: Uint8Array; readonly svg: string } {
  const encoded = serializeInkbookDocument({
    elements: [],
    format: "inkbook",
    page: {
      activeBufferLines: 3,
      background: { spacing: 50, type: "squares" },
      innerWidth: 2000,
      lockedBufferLines: 1,
      margin: 24.3,
    },
    revision: 11,
    version: 1,
  });
  if (!encoded.ok) throw new Error(encoded.error.message);
  return { bytes: new TextEncoder().encode(encoded.value.svg), svg: encoded.value.svg };
}

function customSettings(): {
  readonly device: InkbookDeviceSettingsV2;
  readonly vault: InkbookSettingsV4;
} {
  return {
    device: {
      ...createBuiltInDeviceSettings(),
      fingerDrawingEnabled: true,
      leftHandedToolbar: true,
      motion: "reduced",
    },
    vault: { ...createBuiltInSettings(), startupTool: "select" },
  };
}

function createPluginHarness() {
  const document = serializedDocument();
  const file = new TestTFile("drawings/ink.svg", document.bytes.byteLength);
  const settings = customSettings();
  let cssChange: (() => void) | undefined;
  let quit: ((tasks: Tasks) => void) | undefined;
  let dark = false;
  const ownerWindow = new FakePresentationElement().ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  useAsyncWindowFrames(ownerWindow);
  const readBinary = vi.fn(async () => document.bytes.buffer.slice(0));
  const app = {
    fileManager: {},
    isDarkMode: () => dark,
    loadLocalStorage: (key: string) =>
      key === "inkbook:device-settings:v2" ? settings.device : undefined,
    metadataCache: {
      getFirstLinkpathDest: (linkpath: string) => (linkpath === "drawings/ink.svg" ? file : null),
      on: () => ({ detach: vi.fn() }),
      resolvedLinks: {},
    },
    saveLocalStorage: vi.fn(),
    vault: {
      cachedRead: async () => document.svg,
      getAbstractFileByPath: (path: string) => (path === file.path ? file : null),
      getFileByPath: (path: string) => (path === file.path ? file : null),
      getFolderByPath: () => null,
      getResourcePath: () => "app://vault/drawings/ink.svg",
      on: () => ({ detach: vi.fn() }),
      process: vi.fn(async (_file: TFile, update: (current: string) => string) =>
        update(document.svg),
      ),
      read: async () => document.svg,
      readBinary,
    },
    workspace: {
      containerEl: { ownerDocument: { defaultView: ownerWindow } },
      getActiveViewOfType: () => null,
      getLeavesOfType: () => [],
      on: (name: string, callback: ((tasks: Tasks) => void) | (() => void)) => {
        if (name === "css-change") cssChange = callback as () => void;
        if (name === "quit") quit = callback;
        return { detach: vi.fn() };
      },
      onLayoutReady: (callback: () => void) => {
        callback();
      },
    },
  };
  const plugin = new InkbookPlugin(app as never, {} as never);
  (plugin as unknown as TestPluginRegistration).settingsData = settings.vault;
  return {
    app,
    darken: () => {
      dark = true;
      cssChange?.();
    },
    plugin,
    quit: (tasks: Tasks) => quit?.(tasks),
    readBinary,
    settings,
  };
}

async function mountReadingEmbed(plugin: InkbookPlugin): Promise<{
  readonly button: FakePresentationElement;
  readonly child: MarkdownRenderChild;
  readonly image: FakePresentationElement;
  readonly preview: FakePresentationElement;
  readonly root: FakePresentationElement;
}> {
  const root = new FakePresentationElement();
  useAsyncWindowFrames(root.ownerDocument.defaultView!);
  const nativeHost = new FakePresentationElement(root.ownerDocument);
  const image = new FakePresentationElement(root.ownerDocument, "img");
  image.src = "app://vault/drawings/ink.svg";
  nativeHost.append(image);
  root.append(nativeHost);
  let child: MarkdownRenderChild | undefined;
  const processor = (plugin as unknown as TestPluginRegistration).postProcessors[0];
  if (processor === undefined) throw new Error("Reading-view postprocessor was not registered.");
  await processor(nativeHost as unknown as HTMLElement, {
    addChild: (candidate: MarkdownRenderChild) => {
      child = candidate;
      candidate.load();
    },
    getSectionInfo: () => ({ lineStart: 0, lineEnd: 0, text: "!inkbook[[drawings/ink.svg]]" }),
    sourcePath: "notes/page.md",
  });
  if (child === undefined) throw new Error("Reading-view child was not mounted.");
  const presentationRoot = inkbookRoot(root);
  const button = presentationRoot.children[0];
  const preview = button?.children[0];
  if (button === undefined || preview === undefined) throw new Error("Missing locked preview.");
  return { button, child, image, preview, root };
}

async function createReadyReadingEmbed() {
  scenes.readiness = Promise.resolve(true);
  scenes.records.length = 0;
  const harness = createPluginHarness();
  await harness.plugin.onload();
  const presentation = await mountReadingEmbed(harness.plugin);
  await vi.waitFor(() =>
    expect(presentation.root.classNames).toContain("inkbook-scrollbar-stable"),
  );
  return { harness, presentation };
}

async function activatePresentation(
  presentation: Awaited<ReturnType<typeof mountReadingEmbed>>,
): Promise<void> {
  presentation.button.dispatch("click");
  await vi.waitFor(() => expect(scenes.records).toHaveLength(1));
  expect(inkbookRoot(presentation.root).dataset.inkbookState).toBe("active");
}

async function createDirtyPresentationWithBlockedSave() {
  const { harness, presentation } = await createReadyReadingEmbed();
  await activatePresentation(presentation);
  const scene = scenes.records[0];
  if (scene === undefined) throw new Error("Expected an active scene.");
  let releaseProcess = (): void => undefined;
  const processGate = new Promise<void>((resolve) => {
    releaseProcess = resolve;
  });
  harness.app.vault.process.mockImplementation(
    async (_file: TFile, update: (current: string) => string) => {
      await processGate;
      return update(serializedDocument().svg);
    },
  );
  scene.options.model.commitPage({
    ...scene.options.model.page,
    activeBufferLines: scene.options.model.page.activeBufferLines + 1,
  });
  return { harness, presentation, releaseProcess, scene };
}

describe("plugin runtime scene integration", () => {
  it("runs the input-aware fallback with the presentation window", async () => {
    const document = serializedDocument();
    const root = new FakePresentationElement();
    const owningWindow = root.ownerDocument.defaultView;
    if (owningWindow === null) throw new Error("Missing owner window.");
    const runtime = new DocumentWorkerRuntime(
      { sessionId: "fallback-test", workerEpoch: 2 },
      new GestureAwareSliceScheduler({
        isInputActive: () => false,
        workScheduler: workSchedulerFromFrames(owningWindow),
      }),
    );
    const result = await runtime.execute({
      identity: {
        operationId: 1,
        purpose: "unlock",
        sessionId: "fallback-test",
        workerEpoch: 2,
      },
      input: document.bytes,
      type: "unlock",
    });
    expect(result.type).toBe("unlock-success");
  });
});

describe("plugin workspace realm integration", () => {
  it("moves activation work to the live workspace realm when an embed window closes", async () => {
    const { harness, presentation } = await createReadyReadingEmbed();
    const closedWindow = presentation.root.ownerDocument.defaultView;
    if (closedWindow === null) throw new Error("Missing presentation window.");
    Object.defineProperty(closedWindow, "closed", { value: true });

    await activatePresentation(presentation);
    presentation.child.unload();
    harness.plugin.onunload();
  });

  it("loads a Vault document through the plugin and owns its scene lifecycle", async () => {
    const { harness, presentation } = await createReadyReadingEmbed();

    expect(presentation.root.classNames).toContain("inkbook-scrollbar-stable");
    await activatePresentation(presentation);

    const scene = scenes.records[0];
    expect(scene?.options.model.revision).toBe(11);
    expect(scene?.options.model.store.size).toBe(0);
    expect(scene?.options.startupTool).toBe("select");
    expect(scene?.options.deviceSettings).toEqual(harness.settings.device);
    expect(harness.readBinary).toHaveBeenCalledTimes(1);
    expect(inkbookRoot(presentation.root).dataset.inkbookState).toBe("active");

    harness.darken();
    expect(scene?.setScheme).toHaveBeenLastCalledWith("dark");
    const settingTab = (harness.plugin as unknown as TestPluginRegistration).settingTabs[0];
    await settingTab?.setControlValue("device.motion", "full");
    expect(scene?.updateDeviceSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ motion: "full" }),
    );
    presentation.child.unload();
    expect(scene?.dispose).toHaveBeenCalledTimes(1);
    expect(presentation.root.classNames).not.toContain("inkbook-scrollbar-stable");
    expect(presentation.button.listeners.get("click")?.size ?? 0).toBe(0);

    harness.plugin.onunload();
  });

  it("unloads mounted Reading-view children and scroll leases with the plugin", async () => {
    const { harness, presentation } = await createReadyReadingEmbed();

    expect(presentation.root.classNames).toContain("inkbook-scrollbar-stable");
    harness.plugin.onunload();

    expect(presentation.root.classNames).not.toContain("inkbook-scrollbar-stable");
    expect(presentation.button.listeners.get("click")?.size ?? 0).toBe(0);
  });

  it("keeps the static preview and reports a retryable editor-chrome load failure", async () => {
    let rejectReadiness = (_error: Error): void => undefined;
    scenes.readiness = new Promise<boolean>((_resolve, reject) => {
      rejectReadiness = reject;
    });
    scenes.records.length = 0;
    const harness = createPluginHarness();
    await harness.plugin.onload();
    const presentation = await mountReadingEmbed(harness.plugin);

    presentation.button.dispatch("click");
    await vi.waitFor(() => expect(scenes.records).toHaveLength(1));
    rejectReadiness(new Error("blocked by script-src"));
    await vi.waitFor(() => {
      expect(inkbookRoot(presentation.root).dataset.inkbookState).toBe("load-error");
    });

    expect(scenes.records[0]?.dispose).toHaveBeenCalledOnce();
    expect(presentation.preview.hidden).toBe(false);
    const recoveryPanel = presentation.root.getElementsByClassName("inkbook-feedback").item(0);
    const pendingFeedback = presentation.root
      .getElementsByClassName("inkbook-operation-feedback")
      .item(0);
    const recoveryButtons = recoveryPanel?.getElementsByTagName("button");
    expect(recoveryPanel?.attributes.get("role")).toBe("alert");
    expect(pendingFeedback).toBeNull();
    expect(recoveryButtons?.length).toBe(2);
    expect(recoveryButtons?.item(0)?.attributes.get("aria-label")).toBe("Retry opening drawing");
    expect(recoveryButtons?.item(0)?.children[0]?.attributes.get("data-icon")).toBe("rotate-ccw");
    expect(recoveryButtons?.item(1)?.attributes.get("aria-label")).toBe("Keep saved preview");
    expect(recoveryButtons?.item(1)?.children[0]?.attributes.get("data-icon")).toBe("x");
    presentation.child.unload();
    harness.plugin.onunload();
  });
});

describe("plugin workspace activation serialization", () => {
  it("starts a remounted CodeMirror widget at width fit", async () => {
    scenes.readiness = Promise.resolve(true);
    scenes.records.length = 0;
    const harness = createPluginHarness();
    const ownerWindow = new FakePresentationElement().ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("Missing owner window.");
    useAsyncWindowFrames(ownerWindow);
    const runtime = new ObsidianWorkspaceRuntime(
      harness.app.vault as never,
      harness.app.fileManager as never,
      new ColorSchemeBroadcaster({ getColorScheme: () => "light" }),
      () => harness.settings,
      {} as ObsidianEmbedActions,
      {
        fallbackOwnerWindow: () => ownerWindow,
        manager: new InkbookFeedbackManager(),
        onOpenSettings: vi.fn(),
        onOpenShortcuts: vi.fn(),
      },
    );
    const first = livePreviewAttachment(1);
    runtime.mount(first);
    runtime.activate(first);
    await vi.waitFor(() => expect(scenes.records).toHaveLength(1));
    const firstScene = scenes.records[0];
    if (firstScene === undefined) throw new Error("Expected the first scene.");
    firstScene.viewState = { cameraX: -240, zoom: 1.75 };

    runtime.detach(first);
    const remounted = livePreviewAttachment(2);
    runtime.mount(remounted);
    runtime.activate(remounted);
    await vi.waitFor(() => expect(scenes.records).toHaveLength(2));
    expect(scenes.records[1]?.options.root).toBe(remounted.root);

    scenes.records[1]?.options.onLock();
    await vi.waitFor(() => expect(scenes.records[1]?.finishLock).toHaveBeenCalledOnce());
    runtime.activate(remounted);
    await vi.waitFor(() => expect(scenes.records).toHaveLength(3));
    expect(scenes.records[2]?.options.root).toBe(remounted.root);
    runtime.dispose();
  });

  it("adds a quit task that awaits the latest dirty save", async () => {
    const { harness, releaseProcess } = await createDirtyPresentationWithBlockedSave();
    const tasks = new Tasks();
    harness.quit(tasks);
    let settled = false;
    const draining = tasks.promise().then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(harness.app.vault.process).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    releaseProcess();
    await draining;
    expect(settled).toBe(true);
    harness.plugin.onunload();
  });

  it("does not create an editable scene for a non-active activation outcome", async () => {
    const { harness, presentation, releaseProcess, scene } =
      await createDirtyPresentationWithBlockedSave();

    scene.options.onLock();
    const root = inkbookRoot(presentation.root);
    expect(root.dataset.inkbookState).toBe("locking");
    await vi.waitFor(() =>
      expect(
        root.getElementsByClassName("inkbook-operation-feedback").item(0)?.dataset.inkbookOperation,
      ).toBe("saving"),
    );
    presentation.button.dispatch("click");
    await Promise.resolve();
    expect(scenes.records).toHaveLength(1);
    expect(root.dataset.inkbookState).toBe("locking");
    expect(root.getElementsByClassName("inkbook-operation-feedback").item(0)).not.toBeNull();
    harness.plugin.onunload();
    releaseProcess();
  });
});

function livePreviewAttachment(attachmentGeneration: number): PresentationAttachment {
  const root = new FakePresentationElement();
  useAsyncWindowFrames(root.ownerDocument.defaultView!);
  root.dataset.inkbookScheme = "light";
  return {
    attachmentGeneration,
    attachmentId: "live-preview-widget",
    documentId: "drawings/ink.svg",
    embedReference: {
      documentId: "drawings/ink.svg",
      from: 0,
      kind: "live-preview",
      sourcePath: "notes/page.md",
      to: 21,
    },
    root: root as unknown as HTMLElement,
    scrollOwner: () => root as unknown as HTMLElement,
  };
}
