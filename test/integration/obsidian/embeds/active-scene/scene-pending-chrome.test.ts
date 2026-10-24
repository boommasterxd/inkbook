// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createBuiltInDeviceSettings,
  createBuiltInSettings,
} from "../../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../../src/domain/store/public";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { ActiveInkbookScene } from "../../../../../src/obsidian/embeds/active-scene/active-scene";
import type { InkbookEditorChromeProps } from "../../../../../src/rendering/ui/editor-chrome";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { createActiveEditorModel, key } from "../../../../fixtures/obsidian/active-controller";
import { domRect } from "../../../../fixtures/obsidian/active-editor";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { FakeScheduler } from "../../../../unit/rendering/scene/fakes";
import { createEncodedClipboardFixture } from "../active-editor/active-editor-clipboard-fixtures";

const chrome = vi.hoisted(() => ({
  update: vi.fn<(props: InkbookEditorChromeProps) => void>(),
  sceneCommitted: vi.fn(),
}));

vi.mock("../../../../../src/obsidian/embeds/active-scene/editor-chrome-loader", () => ({
  beginEditorChromeMount: () => ({
    ready: Promise.resolve(true),
    update: chrome.update,
    unmount: vi.fn(),
  }),
}));
vi.mock("../../../../../src/obsidian/embeds/active-editor/layout/layout", () => ({
  ActiveEditorLayout: class {
    public constructor(private readonly options: { onReady(): void }) {}
    public chromeMounted(): void {
      this.options.onReady();
    }
    public readonly chromeChanged = vi.fn();
    public readonly contentChanged = vi.fn();
    public readonly sceneCommitted = chrome.sceneCommitted;
    public readonly consumeOwnZoomScroll = vi.fn(() => false);
    public readonly dispose = vi.fn();
  },
}));
vi.mock("../../../../../src/obsidian/embeds/active-scene/active-scene-handoff", () => ({
  ActiveScenePreviewHandoff: class {
    public constructor(options: { initialScrollStabilityRelease(): void }) {
      options.initialScrollStabilityRelease();
    }
    public readonly reducedMotion = true;
    public ready(callback: () => void): void {
      callback();
    }
    public readonly dispose = vi.fn();
  },
}));

beforeEach(() => {
  installObsidianDomHelpers();
  vi.clearAllMocks();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    domRect({ left: 0, top: 0, width: 1000, height: 800 }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function setup() {
  const root = document.body.createDiv();
  const scheduler = new FakeScheduler();
  const store = new ElementStore();
  const model = createActiveEditorModel(store);
  let releasePaths = (): void => undefined;
  const prepareScenePaths = vi.fn(
    () =>
      new Promise<undefined>((resolve) => {
        releasePaths = () => resolve(undefined);
      }),
  );
  const encoded = createEncodedClipboardFixture();
  let finishCopy = (): void => undefined;
  const encodeClipboard = vi.fn(
    () =>
      new Promise<typeof encoded>((resolve) => {
        finishCopy = () => resolve(encoded);
      }),
  );
  const history = new ActiveEditorHistory(model);
  const settings = createBuiltInSettings();
  const scene = new ActiveInkbookScene({
    root,
    workScheduler: scheduler.workScheduler,
    model: { ...model, encodeClipboard, prepareScenePaths },
    history,
    defaults: settings.toolDefaults,
    deviceSettings: { ...createBuiltInDeviceSettings(), motion: "reduced" },
    backgroundSpacing: () => settings.pageDefaults.backgroundSpacing,
    snapping: settings.snapping,
    startupTool: "draw",
    scheme: "light",
    scrollOwner: () => root,
    onLock: vi.fn(),
    onFeedback: vi.fn(),
    onCopyEmbed: vi.fn(),
    onDeleteEmbed: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenShortcuts: vi.fn(),
  });
  await Promise.resolve();
  scheduler.runAll();
  await scene.ready;
  const props = () => chrome.update.mock.lastCall![0];
  const input = root.querySelector<HTMLElement>(".inkbook-canvas-input")!;
  return {
    root,
    scene,
    store,
    history,
    scheduler,
    prepareScenePaths,
    finishCopy: () => finishCopy(),
    encodeClipboard,
    props,
    input,
    trigger: root.createEl("button"),
    releasePaths: async () => {
      releasePaths();
      await Promise.resolve();
      scheduler.runAll();
    },
    holdScene: () => {
      const commits = chrome.sceneCommitted.mock.calls.length;
      store.create(indexedStroke(0));
      scheduler.runAll();
      expect(prepareScenePaths).toHaveBeenCalledOnce();
      expect(chrome.sceneCommitted).toHaveBeenCalledTimes(commits);
    },
    dispose: () => {
      releasePaths();
      scene.dispose();
      history.dispose();
      root.remove();
    },
  };
}

it("publishes tool, pending clipboard, and copy confirmation state while contours are held", async () => {
  const h = await setup();
  const write = vi.spyOn(navigator.clipboard, "write").mockResolvedValue();
  try {
    h.history.registerApplied({ payloadBytes: 1, undo: async () => true, redo: async () => true });
    h.props().onToolbarAction("select", h.trigger);
    expect(h.props().toolbarState.canUndo).toBe(true);
    h.holdScene();
    h.props().onToolbarAction("draw", h.trigger);
    expect(h.props().toolbarState.activeTool).toBe("draw");
    h.props().onToolbarAction("select", h.trigger);
    expect(h.props().toolbarState.activeTool).toBe("select");
    key(h.input, "a", { ctrlKey: true });
    expect(h.props().toolbarState.hasSelection).toBe(true);
    vi.useFakeTimers();
    h.props().onToolbarAction("copy", h.trigger);
    expect(h.encodeClipboard).toHaveBeenCalledOnce();
    expect(h.props().toolbarState.canUndo).toBe(false);
    h.finishCopy();
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledOnce();
    expect(h.props().toolbarState.actionConfirmation?.action).toBe("copy");
    expect(h.prepareScenePaths).toHaveBeenCalledOnce();
    expect(h.props().toolbarState.canUndo).toBe(true);
    vi.advanceTimersByTime(899);
    expect(h.props().toolbarState.actionConfirmation?.action).toBe("copy");
    vi.advanceTimersByTime(1);
    expect(h.props().toolbarState.actionConfirmation).toBeNull();
    await h.releasePaths();
    expect(h.props().toolbarState.canUndo).toBe(true);
  } finally {
    h.dispose();
  }
});

it("keeps new history availability behind the scene commit while publishing tool feedback", async () => {
  const h = await setup();
  try {
    h.holdScene();
    h.history.registerApplied({ payloadBytes: 1, undo: async () => true, redo: async () => true });
    h.props().onToolbarAction("select", h.trigger);
    expect(h.props().toolbarState).toMatchObject({ activeTool: "select", canUndo: false });
    await h.releasePaths();
    expect(h.props().toolbarState.canUndo).toBe(true);
  } finally {
    h.dispose();
  }
});
