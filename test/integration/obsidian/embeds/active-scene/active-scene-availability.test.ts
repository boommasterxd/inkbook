// @vitest-environment happy-dom

import { beforeEach, expect, it, vi } from "vitest";
import type { SceneRendererOptions } from "../../../../../src/rendering/scene/types";
import type { ActiveInkbookSceneOptions } from "../../../../../src/obsidian/embeds/active-scene/active-scene-types";
import { ActiveInkbookScene } from "../../../../../src/obsidian/embeds/active-scene/active-scene";
import { createBuiltInDeviceSettings } from "../../../../../src/domain/settings/defaults";
import { ActiveScenePreviewHandoff } from "../../../../../src/obsidian/embeds/active-scene/active-scene-handoff";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { domRect } from "../../../../fixtures/obsidian/active-editor";
import { NAVIGATION_PAGE } from "../../../../fixtures/rendering/pressure-navigation";
import { FakeScheduler } from "../../../../unit/rendering/scene/fakes";
import { derivePageExtent, PAGE_WIDTH } from "../../../../../src/domain/geometry/public";

const ports = vi.hoisted(() => ({
  rendererOptions: undefined as SceneRendererOptions | undefined,
  layoutReady: (): void => undefined,
  revealReady: undefined as (() => void) | undefined,
  reducedMotionChange: undefined as ((reduced: boolean) => void) | undefined,
  reducedMotion: true,
  previewReady: Promise.resolve(),
  realHeightOwners: false,
  container: undefined as HTMLDivElement | undefined,
  activeBlockSize: "640px",
  lockFinish: vi.fn(),
  lockRelease: vi.fn(),
  handoffToPreview: vi.fn(),
  enabled: vi.fn(),
  suspend: vi.fn(),
  resume: vi.fn(),
  disposeHandoff: vi.fn(),
  releaseMemory: vi.fn(),
  execute: vi.fn(),
  focus: vi.fn(),
  revealSurface: vi.fn(),
  setScrollPreloadMarginPx: vi.fn(),
  setReducedMotion: vi.fn(),
  prewarmEnabled: vi.fn(),
  prewarmDispose: vi.fn(),
}));

vi.mock("../../../../../src/rendering/scene", () => ({
  SvgSceneRenderer: class {
    public constructor(options: SceneRendererOptions) {
      ports.rendererOptions = options;
    }
    public readonly inputSurface = { focus: ports.focus };
    public readonly setScheme = vi.fn();
    public readonly setReducedMotion = ports.setReducedMotion;
    public readonly setScrollPreloadMarginPx = ports.setScrollPreloadMarginPx;
    public readonly revealSurface = ports.revealSurface;
    public readonly setSelectionHighlightsEnabled = vi.fn();
    public readonly invalidateLayout = vi.fn();
    public readonly releaseInitialOverscan = vi.fn();
    public readonly destroy = vi.fn();
    public readonly hasPendingSceneCommit = false;
    public readonly sceneCommitProof = 1;
  },
}));
vi.mock("../../../../../src/obsidian/embeds/active-editor/controller", () => ({
  ActiveEditorController: class {
    public readonly setEnabled = ports.enabled;
    public readonly chromeProps = vi.fn(() => ({ toolbarState: {} }));
    public readonly executeAction = ports.execute;
    public readonly isActionAvailable = vi.fn(() => true);
    public readonly dispose = vi.fn();
    public readonly updateDeviceSettings = vi.fn();
    public readonly getViewState = vi.fn(() => ({ cameraX: 0, zoom: 1 }));
    public readonly readResizeAnchor = vi.fn();
    public readonly applyResize = vi.fn(() => true);
    public readonly restoreViewState = vi.fn(() => true);
  },
}));
vi.mock("../../../../../src/obsidian/embeds/active-scene/active-scene-prewarm", () => ({
  ActiveScenePrewarmBinding: class {
    public readonly setEnabled = ports.prewarmEnabled;
    public readonly dispose = ports.prewarmDispose;
  },
}));
vi.mock(
  "../../../../../src/obsidian/embeds/active-scene/active-scene-lock",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../../src/obsidian/embeds/active-scene/active-scene-lock")
      >();
    return {
      ...actual,
      applyLockedFitLayout: vi.fn((options: Parameters<typeof actual.applyLockedFitLayout>[0]) =>
        ports.realHeightOwners
          ? actual.applyLockedFitLayout(options)
          : {
              cancel: vi.fn(),
              finish: ports.lockFinish,
              releaseViewportStability: ports.lockRelease,
            },
      ),
      restoreActiveLayout: vi.fn((options: Parameters<typeof actual.restoreActiveLayout>[0]) =>
        ports.realHeightOwners ? actual.restoreActiveLayout(options) : undefined,
      ),
    };
  },
);
vi.mock("../../../../../src/obsidian/embeds/active-editor/layout/layout", () => ({
  ActiveEditorLayout: class {
    public constructor(options: { readonly onReady: () => void }) {
      ports.layoutReady = options.onReady;
    }
    public readonly chromeMounted = (): void => {
      if (ports.realHeightOwners && ports.container !== undefined)
        Object.assign(ports.container.style, { blockSize: ports.activeBlockSize });
      ports.layoutReady();
    };
    public readonly suspend = ports.suspend;
    public readonly resume = ports.resume;
    public readonly sceneCommitted = vi.fn();
    public readonly chromeChanged = vi.fn();
    public readonly updateMotion = vi.fn();
    public readonly dispose = vi.fn();
  },
}));
vi.mock("../../../../../src/obsidian/embeds/active-scene/active-scene-memory", () => ({
  ActiveSceneMemoryBinding: class {
    public readonly store = {};
    public readonly attach = vi.fn();
    public readonly evaluate = vi.fn();
    public readonly release = ports.releaseMemory;
  },
}));
vi.mock("../../../../../src/obsidian/embeds/active-scene/active-scene-runtime", () => ({
  bindSceneScrollOwner: () => ({ dispose: vi.fn() }),
  createInitialSceneRuntime: (options: ActiveInkbookSceneOptions) =>
    ports.realHeightOwners
      ? createHeightRuntime(options)
      : {
          elements: {
            chromeHost: {},
            container: { style: { blockSize: "100px", removeProperty: vi.fn() } },
            editorChrome: { remove: vi.fn() },
          },
          handoff: {
            get reducedMotion() {
              return ports.reducedMotion;
            },
            set onReducedMotionChange(callback: ((reduced: boolean) => void) | undefined) {
              ports.reducedMotionChange = callback;
            },
            onSceneReveal: undefined,
            ready: (ready: () => void) => {
              ports.revealReady = ready;
            },
            dispose: ports.disposeHandoff,
            updateMotion: vi.fn(),
            stopUnlockHeight: vi.fn(),
            releaseHiddenPreview: vi.fn(),
            ensurePreviewReady: () => ports.previewReady,
            handoffToPreview: (_chrome: HTMLElement, resolve: () => void, before: () => void) => {
              ports.handoffToPreview();
              before();
              resolve();
            },
          },
          stability: {
            begin: vi.fn(),
            dispose: vi.fn(),
            waitForSettlement: () => Promise.resolve(),
          },
        },
}));
vi.mock("../../../../../src/obsidian/embeds/active-scene/active-scene-input", () => ({
  attachActiveSceneInputListeners: () => vi.fn(),
  createSceneInputHandlers: () => ({}),
}));
vi.mock("../../../../../src/obsidian/embeds/active-scene/editor-chrome-loader", () => ({
  beginEditorChromeMount: () => ({
    ready: Promise.resolve(true),
    unmount: vi.fn(),
    update: vi.fn(),
  }),
}));

beforeEach(() => {
  installObsidianDomHelpers();
  vi.clearAllMocks();
  ports.rendererOptions = undefined;
  ports.revealReady = undefined;
  ports.reducedMotion = true;
  ports.previewReady = Promise.resolve();
  ports.realHeightOwners = false;
  ports.container = undefined;
});

function createHeightRuntime(options: ActiveInkbookSceneOptions) {
  const editorChrome = options.root.createDiv();
  const chromeHost = editorChrome.createDiv();
  const container = editorChrome.createDiv();
  ports.container = container;
  vi.spyOn(container, "getBoundingClientRect").mockImplementation(() =>
    domRect({
      height: Number.parseFloat(container.style.blockSize),
      left: 0,
      top: 0,
      width: 1_000,
    }),
  );
  return {
    elements: { editorChrome, chromeHost, container },
    handoff: new ActiveScenePreviewHandoff({
      ...options,
      container,
      motion: "full",
      preview: options.preview,
    }),
    stability: {
      begin: () => ports.lockRelease,
      dispose: vi.fn(),
      waitForSettlement: () => Promise.resolve(),
    },
  };
}

function fixture() {
  const onLock = vi.fn();
  const setTimeout = vi.fn(() => 7);
  const clearTimeout = vi.fn();
  const root = {
    dataset: {},
    ownerDocument: { defaultView: { performance: { now: () => 0 }, setTimeout, clearTimeout } },
  } as unknown as HTMLElement;
  const options = {
    root,
    onLock,
    scrollOwner: () => root,
    model: { page: {}, store: { subscribe: () => vi.fn(), getMaximumBottom: () => 0 } },
    deviceSettings: { ...createBuiltInDeviceSettings(), scrollPreloadMarginPx: 800 },
  } as unknown as ActiveInkbookSceneOptions;
  const scene = new ActiveInkbookScene(options);
  return { scene, root, onLock, setTimeout, clearTimeout };
}

it("configures the scene margin and applies live device updates only until disposal", () => {
  const h = fixture();
  expect(ports.rendererOptions?.scrollPreloadMarginPx).toBe(800);
  h.scene.updateDeviceSettings({ ...createBuiltInDeviceSettings(), scrollPreloadMarginPx: 100 });
  expect(ports.setScrollPreloadMarginPx).toHaveBeenCalledExactlyOnceWith(100);
  h.scene.dispose();
  h.scene.updateDeviceSettings({ ...createBuiltInDeviceSettings(), scrollPreloadMarginPx: 300 });
  expect(ports.setScrollPreloadMarginPx).toHaveBeenCalledOnce();
});

it("initializes the renderer preference and forwards live reductions and restorations", () => {
  const h = fixture();
  try {
    expect(ports.rendererOptions?.reducedMotion).toBe(true);
    ports.reducedMotionChange?.(false);
    ports.reducedMotionChange?.(true);
    expect(ports.setReducedMotion.mock.calls).toEqual([[false], [true]]);
  } finally {
    h.scene.dispose();
  }
});

it("finishes live Reduced lock geometry while retaining preview-readiness and scroll ownership", async () => {
  ports.reducedMotion = false;
  let ready = (): void => undefined;
  ports.previewReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const h = fixture();
  try {
    const finish = h.scene.finishLock();
    expect(h.setTimeout).toHaveBeenCalledWith(expect.any(Function), 240);
    ports.reducedMotion = true;
    ports.reducedMotionChange?.(true);
    expect(ports.lockFinish).toHaveBeenCalledOnce();
    expect(h.clearTimeout).toHaveBeenCalledExactlyOnceWith(7);
    await Promise.resolve();
    expect(ports.lockRelease).not.toHaveBeenCalled();
    expect(ports.handoffToPreview).not.toHaveBeenCalled();
    ports.reducedMotion = false;
    ports.reducedMotionChange?.(false);
    expect(h.setTimeout).toHaveBeenCalledOnce();
    expect(ports.lockFinish).toHaveBeenCalledOnce();
    ready();
    await finish;
    expect(ports.handoffToPreview).toHaveBeenCalledOnce();
    expect(ports.lockRelease).toHaveBeenCalledOnce();
  } finally {
    ready();
    h.scene.dispose();
  }
});

it.each(["full", "reduced", "cancel"] as const)(
  "transfers a running unlock height to the real lock owner with %s completion",
  async (completion) => {
    ports.realHeightOwners = true;
    const root = document.body.createDiv();
    const preview = root.createDiv();
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue(
      domRect({
        height: 96,
        left: 0,
        top: 0,
        width: 1_000,
      }),
    );
    const scheduler = new FakeScheduler();
    const releasePreview = vi.fn();
    const scene = new ActiveInkbookScene({
      root,
      preview,
      workScheduler: scheduler.workScheduler,
      releasePreview,
      scrollOwner: () => root,
      model: {
        page: NAVIGATION_PAGE,
        store: { subscribe: () => vi.fn(), getMaximumBottom: () => 0 },
      },
      deviceSettings: { ...createBuiltInDeviceSettings(), motion: "full" },
    } as unknown as ActiveInkbookSceneOptions);
    try {
      await Promise.resolve();
      ports.rendererOptions?.onSceneCommitted?.();
      scheduler.runNext();
      scheduler.runNext();
      scheduler.time = 60;
      scheduler.runNext();
      await scene.ready;
      const container = ports.container!;
      const unlockingHeight = Number.parseFloat(container.style.blockSize);
      expect(unlockingHeight).toBeGreaterThan(96);
      expect(unlockingHeight).toBeLessThan(640);
      scene.disableInput();
      expect(releasePreview).not.toHaveBeenCalled();
      expect(Number.parseFloat(container.style.blockSize)).toBe(unlockingHeight);
      expect(scheduler.pendingCount).toBe(1);
      if (completion === "cancel") scene.restoreAfterFailedLock();
      else if (completion === "reduced")
        scene.updateDeviceSettings({ ...createBuiltInDeviceSettings(), motion: "reduced" });
      scheduler.runAll();
      const expected =
        completion === "cancel"
          ? 640
          : (derivePageExtent(NAVIGATION_PAGE, 0).lockedHeight * 1_000) / PAGE_WIDTH;
      expect(Number.parseFloat(container.style.blockSize)).toBeCloseTo(expected);
      expect(scheduler.pendingCount).toBe(0);
      expect(releasePreview).toHaveBeenCalledTimes(completion === "cancel" ? 1 : 0);
    } finally {
      scene.dispose();
      root.remove();
    }
    expect(scheduler.pendingCount).toBe(0);
  },
);

it("pauses speculative preparation before lock work and resumes a ready scene after failure", async () => {
  const h = fixture();
  try {
    await Promise.resolve();
    ports.rendererOptions?.onSceneCommitted?.();
    ports.revealReady?.();
    h.scene.disableInput();
    h.scene.disableInput();
    expect(ports.prewarmEnabled.mock.calls).toEqual([[false], [false], [false]]);
    expect(ports.prewarmEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      ports.suspend.mock.invocationCallOrder[0]!,
    );
    h.scene.restoreAfterFailedLock();
    h.scene.enableInput();
    expect(ports.prewarmEnabled.mock.calls.slice(-2)).toEqual([[true], [true]]);
  } finally {
    h.scene.dispose();
  }
  expect(ports.prewarmDispose).toHaveBeenCalledOnce();
});

it("pauses once when finishLock starts without an earlier input-disable call", async () => {
  const h = fixture();
  try {
    const finish = h.scene.finishLock();
    expect(h.scene.finishLock()).toBe(finish);
    expect(ports.prewarmEnabled).toHaveBeenCalledExactlyOnceWith(false);
    await finish;
  } finally {
    h.scene.dispose();
  }
});

it.each([false, true])(
  "retries failed preview readiness after surfaceFailed=%s",
  async (failed) => {
    const h = fixture();
    try {
      if (failed) ports.rendererOptions?.onSurfaceFailure?.();
      ports.previewReady = Promise.reject(new Error("preview unavailable"));
      await expect(h.scene.finishLock()).rejects.toThrow("preview unavailable");
      expect(ports.handoffToPreview).not.toHaveBeenCalled();
      ports.previewReady = Promise.resolve();
      await expect(h.scene.finishLock()).resolves.toBeUndefined();
      expect(ports.handoffToPreview).toHaveBeenCalledOnce();
    } finally {
      h.scene.dispose();
    }
  },
);

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
      expect(ports.disposeHandoff).not.toHaveBeenCalled();
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
      let previewReady!: () => void;
      ports.previewReady = new Promise<void>((resolve) => {
        previewReady = resolve;
      });
      const finish = h.scene.finishLock();
      await Promise.resolve();
      expect(ports.handoffToPreview).not.toHaveBeenCalled();
      previewReady();
      await expect(finish).resolves.toBeUndefined();
      expect(ports.handoffToPreview).toHaveBeenCalledOnce();
      await expect(h.scene.ready).resolves.toBe(ready);
    } finally {
      h.scene.dispose();
    }
    expect(ports.releaseMemory).toHaveBeenCalledOnce();
  },
);
