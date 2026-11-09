// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import {
  TFile,
  Tasks,
  editorInfoField,
  editorLivePreviewField,
  type Editor,
  type MarkdownView,
  type Command,
} from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { activateInkbookPlugin } from "../../../src/obsidian/inkbook-plugin";
import { STRAIGHT_HIGHLIGHTER_ICON_ID } from "../../../src/rendering/ui/icon-ids";
import {
  configureTestEditorState,
  testIconRegistry,
  type Plugin as RegisteredPlugin,
} from "../../adapters/obsidian/plugin";
import { TestPlugin } from "../../fixtures/obsidian/test-plugin";
import { PresentationLifecycleRegistry } from "../../../src/obsidian/embeds/presentation/presentation-lifecycle-registry";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { createSnapshot } from "../../unit/persistence/serialization/fixtures";
import * as embedBindings from "../../../src/obsidian/embeds";
import { WorkspaceRefreshProfiles } from "../../../src/obsidian/embeds/workspace/workspace-refresh-profiles";
import { createMarkdownExportFixture } from "../../fixtures/obsidian/markdown-export";
import { ManualHost } from "../../fixtures/scheduling/manual-frame-host";
import { FRAME_WORK_SHARE } from "../../../src/domain/scheduling/work-scheduler";

const TestTFile = TFile as unknown as new (path: string) => TFile;

function expectRegisteredCommands(commands: readonly Pick<Command, "id">[]): void {
  expect(commands.map((command) => command.id)).toEqual([
    "lock-active-embed",
    "copy-embed",
    "erase-all",
    "delete-embed",
    "insert-handwriting",
  ]);
  for (const command of commands) expect(command).not.toHaveProperty("hotkeys");
}

function createApp() {
  const cssChange = vi.fn();
  const metadataEvents = new Map<string, () => void>();
  const vaultEvents = new Map<string, (file: TFile) => void>();
  const workspaceEvents = new Map<string, (...arguments_: never[]) => void>();
  let markLayoutReady: (() => void) | undefined;
  let frameTimestamp = 0;
  const ownerDocument = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    visibilityState: "visible",
  } as unknown as Document;
  const ownerWindow = {
    addEventListener: vi.fn(),
    cancelAnimationFrame: vi.fn(),
    clearTimeout: vi.fn(),
    closed: false,
    document: ownerDocument,
    performance,
    removeEventListener: vi.fn(),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frameTimestamp += 1_000 / 120;
      callback(frameTimestamp);
      return frameTimestamp;
    },
    setTimeout: vi.fn(() => 1),
  } as unknown as Window;
  Object.assign(ownerDocument, { defaultView: ownerWindow });
  const containerEl = {
    ownerDocument: { defaultView: ownerWindow },
  } as unknown as HTMLElement;
  return {
    app: {
      isDarkMode: () => false,
      loadLocalStorage: () => undefined,
      saveLocalStorage: vi.fn(),
      metadataCache: {
        getFirstLinkpathDest: () => null,
        on: (name: string, callback: () => void) => {
          metadataEvents.set(name, callback);
          return { detach: vi.fn() };
        },
        resolvedLinks: {},
      },
      vault: {
        on: (name: string, callback: (file: TFile) => void) => {
          vaultEvents.set(name, callback);
          return { detach: vi.fn() };
        },
      },
      workspace: {
        containerEl,
        getActiveViewOfType: () => null,
        on: (name: string, callback: (...arguments_: never[]) => void) => {
          if (name === "css-change") cssChange.mockImplementation(callback);
          workspaceEvents.set(name, callback);
          return { detach: vi.fn() };
        },
        onLayoutReady: (callback: () => void) => {
          markLayoutReady = callback;
        },
      },
    },
    cssChange,
    layoutReady: () => markLayoutReady?.(),
    metadataEvents,
    vaultEvents,
    workspaceEvents,
  };
}

describe("plugin startup recognition", () => {
  it.each([false, true])("keeps native images without early reads; unload=%s", async (unload) => {
    const { app, layoutReady } = createApp();
    const serialized = serializeInkbookDocument(createSnapshot());
    if (!serialized.ok) throw new Error("Expected a canonical Inkbook fixture.");
    const file = new TestTFile(unload ? "drawing.svg" : "external.SVG");
    file.stat.size = new TextEncoder().encode(serialized.value.svg).byteLength;
    const cachedRead = vi.fn(async () => serialized.value.svg);
    const plugin = new TestPlugin(
      {
        ...app,
        metadataCache: { ...app.metadataCache, getFirstLinkpathDest: () => file },
        vault: {
          ...app.vault,
          cachedRead,
          getFileByPath: () => file,
          getResourcePath: () => `app://${file.path}`,
        },
      } as never,
      {} as never,
    );
    const binding = vi.spyOn(embedBindings, "createLivePreviewExtension");
    const deactivate = await activateInkbookPlugin(plugin);
    configureTestEditorState({ file: { path: "note.md" }, livePreview: true });
    const registrations = plugin as unknown as { editorExtensions: [] };
    const state = EditorState.create({
      doc: `![[${file.path}]]`,
      extensions: [editorInfoField, editorLivePreviewField, ...registrations.editorExtensions],
    });
    expect((state.facet(EditorView.decorations)[0] as DecorationSet).size).toBe(0);
    const recognition = binding.mock.calls[binding.mock.calls.length - 1]![0].documents.recognize(
      file.path,
    );
    binding.mockRestore();
    await Promise.resolve();
    expect(cachedRead).not.toHaveBeenCalled();
    if (unload) deactivate?.();
    layoutReady();
    if (unload) await expect(recognition).resolves.toBe(false);
    else
      await expect(recognition).resolves.toMatchObject({
        safeSvg: serialized.value.svg,
        contentIdentity: {
          outputHash: serialized.value.hash,
          revision: serialized.value.snapshot.revision,
        },
      });
    expect(cachedRead).toHaveBeenCalledTimes(unload ? 0 : 1);
    if (!unload) deactivate?.();
  });
});

describe("plugin host registration", () => {
  it("loads settings and registers both embed surfaces, settings, theme, and commands", async () => {
    const refreshOwners = vi.spyOn(
      PresentationLifecycleRegistry.prototype,
      "refreshOwnerDocuments",
    );
    const { app, cssChange, layoutReady, metadataEvents, vaultEvents, workspaceEvents } =
      createApp();
    const plugin = new TestPlugin(app as never, {} as never);

    const deactivate = await activateInkbookPlugin(plugin);
    expect(testIconRegistry.has(STRAIGHT_HIGHLIGHTER_ICON_ID)).toBe(true);
    const registrations = plugin as unknown as {
      readonly commands: Array<{
        readonly checkCallback?: (checking: boolean) => boolean | void;
        readonly editorCheckCallback?: (
          checking: boolean,
          editor: Editor,
          context: MarkdownView,
        ) => boolean | void;
        readonly id: string;
      }>;
      readonly editorExtensions: unknown[];
      readonly postProcessors: unknown[];
      readonly settingTabs: unknown[];
    };

    expect(registrations.postProcessors).toHaveLength(1);
    expect(registrations.editorExtensions).toHaveLength(1);
    expect(vaultEvents.size).toBe(0);
    expect(registrations.settingTabs).toHaveLength(1);
    const statusItems = (plugin as unknown as RegisteredPlugin).statusBarItems;
    expect(statusItems).toHaveLength(1);
    expect(statusItems[0]?.classList.contains("inkbook-status-bar-item")).toBe(true);
    expect((statusItems[0]?.children[0] as HTMLElement | undefined)?.dataset.saveStatus).toBe(
      "inactive",
    );
    expect(workspaceEvents.has("active-leaf-change")).toBe(true);
    workspaceEvents.get("layout-change")?.();
    expect(refreshOwners).toHaveBeenCalledOnce();
    refreshOwners.mockRestore();
    expectRegisteredCommands(registrations.commands);
    expect(cssChange).toHaveBeenCalledTimes(0);
    expect([...metadataEvents.keys()]).toEqual(["changed", "resolved"]);
    expect(workspaceEvents.has("quit")).toBe(true);
    expect(workspaceEvents.has("editor-menu")).toBe(true);
    expect(workspaceEvents.has("editor-change")).toBe(false);
    expect(registrations.commands[0]?.checkCallback?.(true)).toBe(false);
    const insertion = registrations.commands.find(
      (command) => command.id === "insert-handwriting",
    )?.editorCheckCallback;
    const editor = {
      getCursor: () => ({ ch: 0, line: 0 }),
      getLine: () => "",
      getRange: () => "",
      lineCount: () => 1,
      replaceRange: vi.fn(),
    } as unknown as Editor;
    const context = { file: new TestTFile("notes/page.md") } as MarkdownView;
    expect(insertion?.(true, editor, context)).toBe(false);
    layoutReady();
    expect(registrations.postProcessors).toHaveLength(1);
    expect(registrations.editorExtensions).toHaveLength(2);
    expect(registrations.editorExtensions[1]).toHaveLength(3);
    expect([...vaultEvents.keys()]).toEqual(["create", "modify", "delete", "rename"]);
    expect(workspaceEvents.has("editor-change")).toBe(true);
    expect(insertion?.(true, editor, context)).toBe(true);

    const tasks = new Tasks();
    workspaceEvents.get("quit")?.(tasks as never);
    expect(tasks.isEmpty()).toBe(true);

    deactivate?.();
    expect(statusItems[0]?.children).toHaveLength(0);
    expect(testIconRegistry.has(STRAIGHT_HIGHLIGHTER_ICON_ID)).toBe(false);
  });

  it("does not start layout-owned input or vault work after deactivation", async () => {
    const { app, layoutReady, vaultEvents } = createApp();
    const plugin = new TestPlugin(app as never, {} as never);
    const deactivate = await activateInkbookPlugin(plugin);

    deactivate?.();
    layoutReady();

    const registrations = plugin as unknown as {
      readonly editorExtensions: unknown[];
      readonly postProcessors: unknown[];
    };
    expect(registrations.postProcessors).toHaveLength(1);
    expect(registrations.editorExtensions).toHaveLength(1);
    expect(vaultEvents.size).toBe(0);
  });
});

describe("sectionless export refresh ownership", () => {
  it.each([
    { rate: 60, abort: false },
    { rate: 120, abort: false },
    { rate: 240, abort: false },
    { rate: 120, abort: true },
  ])("owns the target-window Auto profile at $rate Hz; abort=$abort", async ({ rate, abort }) => {
    const { app } = createApp();
    const plugin = new TestPlugin(app as never, {} as never);
    const binding = vi.spyOn(embedBindings, "createReadingViewPostProcessor");
    const acquire = vi.spyOn(WorkspaceRefreshProfiles.prototype, "acquire");
    const release = vi.spyOn(WorkspaceRefreshProfiles.prototype, "release");
    const deactivate = await activateInkbookPlugin(plugin);
    const ports = binding.mock.calls[0]![0];
    const fixture = createMarkdownExportFixture(
      "![[drawing.svg]]",
      '<p><span><img alt="drawing.svg" src="app://vault/drawing.svg"></span></p>',
    );
    const host = new ManualHost();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(host.requestFrame);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(host.cancelFrame);
    vi.spyOn(window.performance, "now").mockReturnValue(0);
    const removedListeners = vi.spyOn(document, "removeEventListener");
    let finish!: () => void;
    const preparation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fixture.prepareStaticExport.mockImplementation(() => preparation);
    const pending = Promise.resolve(
      embedBindings.createReadingViewPostProcessor({
        ...fixture.ports,
        acquireSchedulingProfile: ports.acquireSchedulingProfile!,
        workScheduler: ports.workScheduler,
      })(fixture.root, fixture.context),
    );
    try {
      await vi.waitFor(() => expect(fixture.prepareStaticExport).toHaveBeenCalledOnce());
      expect(acquire).toHaveBeenCalledOnce();
      expect(acquire.mock.calls[0]?.slice(1)).toEqual([window, document]);
      const profiles = acquire.mock.contexts[0]!;
      if (!(profiles instanceof WorkspaceRefreshProfiles))
        throw new Error("Missing export profile owner.");
      const scheduler = ports.workScheduler(window);
      expect(profiles.status(window)).toEqual({ kind: "detecting", refreshRate: 120 });
      expect(scheduler.budgetMs()).toBeCloseTo((1_000 / 120) * FRAME_WORK_SHARE);
      expect(host.pendingFrames).toBe(1);
      release.mockClear();
      if (abort) {
        fixture.unload();
        expect(host.pendingFrames).toBe(0);
      } else {
        for (let frame = 0; frame < 19; frame += 1) host.frame(frame * (1_000 / rate));
        expect(profiles.status(window)).toEqual({ kind: "detected", refreshRate: rate });
        expect(scheduler.budgetMs()).toBeCloseTo((1_000 / rate) * FRAME_WORK_SHARE);
      }
      finish();
      await pending;
      expect(release).toHaveBeenCalledExactlyOnceWith(acquire.mock.calls[0]![0]);
      expect(removedListeners.mock.calls.some(([type]) => type === "visibilitychange")).toBe(true);
      expect(host.pendingFrames).toBe(0);
      expect(fixture.root.querySelectorAll("svg[role='img']")).toHaveLength(abort ? 0 : 1);
      fixture.unload();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      finish();
      fixture.unload();
      await pending;
      deactivate?.();
      vi.restoreAllMocks();
    }
  });

  it.each([
    { source: "ordinary text", html: "<p>ordinary text</p>" },
    { source: "![[image.png]]", html: '<p>!<a href="image.png">image.png</a></p>' },
  ])(
    "does not acquire a profile without a supported candidate: $source",
    async ({ source, html }) => {
      const fixture = createMarkdownExportFixture(source, html);
      const acquireSchedulingProfile = vi.fn(() => () => undefined);
      try {
        await embedBindings.createReadingViewPostProcessor({
          ...fixture.ports,
          acquireSchedulingProfile,
        })(fixture.root, fixture.context);
        expect(acquireSchedulingProfile).not.toHaveBeenCalled();
        expect(fixture.prepareStaticExport).not.toHaveBeenCalled();
      } finally {
        fixture.unload();
      }
    },
  );
});
