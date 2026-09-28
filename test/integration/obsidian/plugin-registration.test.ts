import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import {
  TFile,
  Tasks,
  editorInfoField,
  editorLivePreviewField,
  type Editor,
  type MarkdownView,
} from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { activateInkbookPlugin } from "../../../src/obsidian/inkbook-plugin";
import { STRAIGHT_HIGHLIGHTER_ICON_ID } from "../../../src/rendering/ui/icon-ids";
import { configureTestEditorState, testIconRegistry } from "../../adapters/obsidian/plugin";
import { InkbookLoadingPreviewWidget } from "../../../src/obsidian/embeds/live-preview-loading-widget";
import { TestPlugin } from "../../fixtures/obsidian/test-plugin";

const TestTFile = TFile as unknown as new (path: string) => TFile;

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

describe("plugin startup placeholders", () => {
  it.each([false, true])(
    "shows a startup placeholder without early reads; unload=%s",
    async (unload) => {
      const { app, layoutReady } = createApp();
      const file = new TestTFile("drawing.svg");
      const cachedRead = vi.fn(async () => "<svg/>");
      const plugin = new TestPlugin(
        {
          ...app,
          metadataCache: { ...app.metadataCache, getFirstLinkpathDest: () => file },
          vault: {
            ...app.vault,
            cachedRead,
            getFileByPath: () => file,
            getResourcePath: () => "app://drawing.svg",
          },
        } as never,
        {} as never,
      );
      const deactivate = await activateInkbookPlugin(plugin);
      configureTestEditorState({ file: { path: "note.md" }, livePreview: true });
      const registrations = plugin as unknown as { editorExtensions: [] };
      const state = EditorState.create({
        doc: "!inkbook[[drawing.svg]]",
        extensions: [editorInfoField, editorLivePreviewField, ...registrations.editorExtensions],
      });
      let widget: InkbookLoadingPreviewWidget | undefined;
      (state.facet(EditorView.decorations)[0] as DecorationSet).between(
        0,
        state.doc.length,
        (_from, _to, decoration) => {
          widget = (decoration.spec as { widget: InkbookLoadingPreviewWidget }).widget;
        },
      );
      expect(widget).toBeInstanceOf(InkbookLoadingPreviewWidget);
      const recognition = widget!.ports.documents.recognize(file.path);
      await Promise.resolve();
      expect(cachedRead).not.toHaveBeenCalled();
      if (unload) deactivate?.();
      layoutReady();
      await expect(recognition).resolves.toBe(false);
      expect(cachedRead).toHaveBeenCalledTimes(unload ? 0 : 1);
      if (!unload) deactivate?.();
    },
  );
});

describe("plugin host registration", () => {
  it("loads settings and registers both embed surfaces, settings, theme, and commands", async () => {
    const { app, cssChange, layoutReady, metadataEvents, vaultEvents, workspaceEvents } =
      createApp();
    const plugin = new TestPlugin(app as never, {} as never);

    const deactivate = await activateInkbookPlugin(plugin);
    const straightHighlighterIcon = testIconRegistry.get(STRAIGHT_HIGHLIGHTER_ICON_ID);
    expect(straightHighlighterIcon).toMatch(/^<svg /u);
    expect(straightHighlighterIcon).toContain('viewBox="0 0 24 24"');
    expect(straightHighlighterIcon).toContain('fill="none" stroke="currentColor"');
    expect(straightHighlighterIcon).toContain('data-inkbook-ruler-marks="true"');
    expect(straightHighlighterIcon).not.toContain("<g");
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
    expect(registrations.commands.map((command) => command.id)).toEqual([
      "lock-active-embed",
      "copy-embed",
      "erase-all",
      "delete-embed",
      "insert-handwriting",
    ]);
    expect(registrations.commands).toHaveLength(5);
    for (const command of registrations.commands) expect(command).not.toHaveProperty("hotkeys");
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
    expect([...vaultEvents.keys()]).toEqual(["create", "modify"]);
    expect(workspaceEvents.has("editor-change")).toBe(true);
    expect(insertion?.(true, editor, context)).toBe(true);

    const tasks = new Tasks();
    workspaceEvents.get("quit")?.(tasks as never);
    expect(tasks.isEmpty()).toBe(false);
    await expect(tasks.promise()).resolves.toEqual([undefined]);

    deactivate?.();
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
