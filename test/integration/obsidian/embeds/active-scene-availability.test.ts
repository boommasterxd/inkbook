import { beforeEach, expect, it, vi } from "vitest";
import type { SceneRendererOptions } from "../../../../src/rendering/scene/types";
import type { ActiveInkbookSceneOptions } from "../../../../src/obsidian/embeds/active-scene-types";
import { ActiveInkbookScene } from "../../../../src/obsidian/embeds/active-scene";

const ports = vi.hoisted(() => ({
  rendererOptions: undefined as SceneRendererOptions | undefined,
  layoutReady: (): void => undefined,
  revealReady: undefined as (() => void) | undefined,
  enabled: vi.fn(),
  suspend: vi.fn(),
  resume: vi.fn(),
  disposeHandoff: vi.fn(),
  releaseMemory: vi.fn(),
  execute: vi.fn(),
  focus: vi.fn(),
  revealSurface: vi.fn(),
}));

vi.mock("../../../../src/rendering/scene", () => ({
  SvgSceneRenderer: class {
    public constructor(options: SceneRendererOptions) {
      ports.rendererOptions = options;
    }
    public readonly inputSurface = { focus: ports.focus };
    public readonly setScheme = vi.fn();
    public readonly revealSurface = ports.revealSurface;
    public readonly setSelectionHighlightsEnabled = vi.fn();
    public readonly invalidateLayout = vi.fn();
    public readonly releaseInitialOverscan = vi.fn();
    public readonly destroy = vi.fn();
    public readonly hasPendingSceneCommit = false;
    public readonly sceneCommitProof = 1;
  },
}));
vi.mock("../../../../src/obsidian/embeds/active-editor/controller", () => ({
  ActiveEditorController: class {
    public readonly setEnabled = ports.enabled;
    public readonly chromeProps = vi.fn(() => ({}));
    public readonly executeAction = ports.execute;
    public readonly isActionAvailable = vi.fn(() => true);
    public readonly dispose = vi.fn();
  },
}));
vi.mock("../../../../src/obsidian/embeds/active-editor/layout", () => ({
  ActiveEditorLayout: class {
    public constructor(options: { readonly onReady: () => void }) {
      ports.layoutReady = options.onReady;
    }
    public readonly chromeMounted = (): void => ports.layoutReady();
    public readonly suspend = ports.suspend;
    public readonly resume = ports.resume;
    public readonly sceneCommitted = vi.fn();
    public readonly dispose = vi.fn();
  },
}));
vi.mock("../../../../src/obsidian/embeds/active-scene-memory", () => ({
  ActiveSceneMemoryBinding: class {
    public readonly store = {};
    public readonly attach = vi.fn();
    public readonly evaluate = vi.fn();
    public readonly release = ports.releaseMemory;
  },
}));
vi.mock("../../../../src/obsidian/embeds/active-scene-runtime", () => ({
  bindSceneScrollOwner: () => ({ dispose: vi.fn() }),
  createInitialSceneRuntime: () => ({
    elements: { chromeHost: {}, container: {}, editorChrome: { remove: vi.fn() } },
    handoff: {
      reducedMotion: true,
      onSceneReveal: undefined,
      ready: (ready: () => void) => {
        ports.revealReady = ready;
      },
      dispose: ports.disposeHandoff,
    },
    stability: { begin: vi.fn(), dispose: vi.fn() },
  }),
}));
vi.mock("../../../../src/obsidian/embeds/active-scene-input", () => ({
  attachActiveSceneInputListeners: () => vi.fn(),
  createSceneInputHandlers: () => ({}),
}));
vi.mock("../../../../src/obsidian/embeds/editor-chrome-loader", () => ({
  beginEditorChromeMount: () => ({ ready: Promise.resolve(true), unmount: vi.fn() }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  ports.rendererOptions = undefined;
  ports.revealReady = undefined;
});

function fixture() {
  const onLock = vi.fn();
  const root = { ownerDocument: { defaultView: {} } } as unknown as HTMLElement;
  const options = {
    root,
    onLock,
    scrollOwner: () => root,
    model: { page: {}, store: { subscribe: () => vi.fn() } },
  } as unknown as ActiveInkbookSceneOptions;
  const scene = new ActiveInkbookScene(options);
  return { scene, root, onLock };
}

it.each([false, true])(
  "permanently rejects interaction after drawing-document failure when ready=%s",
  async (ready) => {
    const h = fixture();
    try {
      await Promise.resolve();
      expect(ports.rendererOptions?.surfaceThemeRoot).toBe(h.root);
      ports.rendererOptions?.onSceneCommitted?.();
      expect(ports.revealReady).toBeTypeOf("function");
      if (ready) ports.revealReady?.();
      ports.enabled.mockClear();
      ports.rendererOptions?.onSurfaceFailure?.();
      ports.rendererOptions?.onSurfaceFailure?.();
      expect(ports.enabled).toHaveBeenCalledExactlyOnceWith(false);
      expect(ports.suspend).toHaveBeenCalledOnce();
      expect(ports.disposeHandoff).toHaveBeenCalledOnce();
      expect(h.onLock).toHaveBeenCalledOnce();
      expect(ports.releaseMemory).not.toHaveBeenCalled();
      ports.enabled.mockClear();
      ports.focus.mockClear();
      ports.revealReady?.();
      ports.rendererOptions?.onSceneCommitted?.();
      h.scene.enableInput();
      h.scene.restoreAfterFailedLock();
      h.scene.executeAction("copy");
      expect(h.scene.isActionAvailable("copy")).toBe(false);
      expect(ports.enabled).not.toHaveBeenCalled();
      expect(ports.resume).not.toHaveBeenCalled();
      expect(ports.focus).not.toHaveBeenCalled();
      expect(ports.execute).not.toHaveBeenCalled();
      await expect(h.scene.finishLock()).resolves.toBeUndefined();
      await expect(h.scene.ready).resolves.toBe(ready);
    } finally {
      h.scene.dispose();
    }
    expect(ports.releaseMemory).toHaveBeenCalledOnce();
  },
);
