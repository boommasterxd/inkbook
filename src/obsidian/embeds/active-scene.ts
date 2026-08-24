import { setIcon } from "obsidian";

import type {
  InkbookDeviceSettingsV1,
  InkbookSettingsV1,
  StartupToolV1,
  ToolDefaultsV1,
} from "../../domain/settings/types";
import type { InkElementV1 } from "../../domain/schema/public";
import type { StoreDelta } from "../../domain/store/public";
import { SvgSceneRenderer, type SceneInputHandlers } from "../../rendering/scene/index";
import { beginEditorChromeMount, type PendingEditorChrome } from "./editor-chrome-loader";
import type { ContextMenuAction, MenuFactoryPort } from "../menus/index";
import { obsidianMenuFactory } from "../menus/index";
import {
  browserScrollMetrics,
  createBrowserScrollDocumentPort,
  resolveScrollOwner,
  type BrowserScrollElement,
} from "../scrolling/index";
import type { InkbookColorScheme } from "../theme/color-scheme";
import { ActiveEditorController } from "./active-editor/controller";
import { ActiveEditorLayout } from "./active-editor/layout";
import type { ActiveEditorViewState } from "./active-editor/navigation";
import { ElementSceneStore } from "./active-editor/scene-store";
import { ActiveScenePreviewHandoff } from "./active-scene-handoff";
import { ActiveSceneMemoryBinding } from "./active-scene-memory";
import { ActiveSceneTimeout } from "./active-scene-timeout";
import { attachActiveSceneInputListeners } from "./active-scene-input";
import { bindActiveSceneScrollOwner, type ActiveSceneScrollBinding } from "./active-scene-scroll";
import {
  applyLockedFitLayout,
  lockedPageAspectRatio,
  LOCK_LAYOUT_DURATION_MS,
  restoreActiveLayout,
  type LockedFitTransition,
} from "./active-scene-lock";
import { createActiveSceneChromeElements, updateActiveSceneChrome } from "./active-scene-chrome";
import { readActiveSceneViewport } from "./active-scene-viewport";
import { InitialSceneReadiness } from "./initial-scene-readiness";
import type { EditableDocumentModel } from "./vault-document-session";
import type { ActiveEditorHistory } from "./active-editor/history";

export { ActiveScenePreviewHandoff } from "./active-scene-handoff";
export { readActiveSceneViewport } from "./active-scene-viewport";

export interface ActiveInkbookSceneOptions {
  readonly backgroundSpacing: () => InkbookSettingsV1["pageDefaults"]["backgroundSpacing"];
  readonly defaults: ToolDefaultsV1;
  readonly deviceSettings: InkbookDeviceSettingsV1;
  readonly menuFactory?: MenuFactoryPort;
  readonly initialViewState?: ActiveEditorViewState;
  readonly history: ActiveEditorHistory;
  readonly model: EditableDocumentModel;
  readonly onLock: () => void;
  readonly onNotice: (message: string) => void;
  readonly onCopyEmbed: () => void;
  readonly onDeleteEmbed: () => void;
  readonly onFirstStrokeCommitted?: () => void;
  readonly root: HTMLElement;
  readonly preview?: HTMLElement;
  readonly setPreviewSource?: (source: string) => Promise<void>;
  readonly setPreviewAspectRatio?: (aspectRatio: number) => void;
  readonly scheme: InkbookColorScheme;
  readonly scrollOwner?: () => BrowserScrollElement | null;
  readonly startupTool: StartupToolV1;
}

export class ActiveInkbookScene {
  readonly #chrome: PendingEditorChrome;
  readonly #chromeHost: HTMLDivElement;
  readonly #container: HTMLDivElement;
  readonly #controller: ActiveEditorController;
  #disposed = false;
  readonly #editorChrome: HTMLDivElement;
  readonly #layout: ActiveEditorLayout;
  readonly #removeInputListeners: () => void;
  #lockLayoutTransition: LockedFitTransition | undefined;
  readonly #lockDelay: ActiveSceneTimeout;
  #lockGeneration = 0;
  #lockPromise: Promise<void> | undefined;
  #lockStartedAt: number | undefined;
  #preLockBlockSize: string | undefined;
  #preLockViewState: ActiveEditorViewState | undefined;
  readonly #previewHandoff: ActiveScenePreviewHandoff;
  readonly #model: EditableDocumentModel;
  readonly #memory: ActiveSceneMemoryBinding;
  readonly #onFirstStrokeCommitted: (() => void) | undefined;
  #firstStrokeCommitted = false;
  #chromeUpdatePending = false;
  readonly #removeViewportListeners: () => void;
  #readyForInput = false;
  #previewReady: Promise<void> = Promise.resolve();
  readonly #initialViewState: ActiveEditorViewState | undefined;
  readonly #initialSceneReadiness = new InitialSceneReadiness();
  readonly #resolveReady: (ready: boolean) => void;
  readonly #renderer: SvgSceneRenderer;
  readonly #root: HTMLElement;
  readonly #store: ElementSceneStore;
  readonly #unsubscribeStore: () => void;
  public readonly ready: Promise<boolean>;

  public constructor(options: ActiveInkbookSceneOptions) {
    this.#root = options.root;
    this.#model = options.model;
    this.#onFirstStrokeCommitted = options.onFirstStrokeCommitted;
    this.#initialViewState = options.initialViewState;
    const elements = createSceneElements(options.root, options.deviceSettings.motion);
    this.#chromeHost = elements.chromeHost;
    this.#container = elements.container;
    this.#editorChrome = elements.editorChrome;
    this.#previewHandoff = createPreviewHandoff(elements.container, options);
    this.#memory = new ActiveSceneMemoryBinding(options.model.store);
    this.#store = this.#memory.store;
    const scrollOwner = options.scrollOwner?.() ?? resolveActiveScrollOwner(options.root);
    const ownerWindow = options.root.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The active scene requires an owning window.");
    this.#lockDelay = new ActiveSceneTimeout(ownerWindow);

    let controller: ActiveEditorController | undefined;
    let scrollBinding: ActiveSceneScrollBinding | undefined;
    this.#renderer = new SvgSceneRenderer({
      container: this.#container,
      inputHandlers: createSceneInputHandlers(() => controller),
      layout: {
        readViewport: () =>
          readActiveSceneViewport(this.#container, scrollBinding?.current() ?? scrollOwner),
      },
      page: options.model.page,
      onResourceUsageChanged: this.#memory.evaluate,
      onSceneCommitted: () => this.#sceneCommitted(),
      reducedMotion: this.#previewHandoff.reducedMotion,
      store: this.#store,
    });
    this.#memory.attach(this.#renderer);
    this.#renderer.setScheme(options.scheme);
    this.#controller = controller = new ActiveEditorController({
      applyZoomLayout: (update) => this.#layout.applyZoom(update),
      backgroundSpacing: options.backgroundSpacing,
      container: this.#container,
      defaults: options.defaults,
      deviceSettings: options.deviceSettings,
      history: options.history,
      interruptLayoutForInput: () => this.#layout.interruptForInput(),
      menuFactory: options.menuFactory ?? obsidianMenuFactory,
      model: options.model,
      onLock: options.onLock,
      onNotice: options.onNotice,
      onCopyEmbed: options.onCopyEmbed,
      onDeleteEmbed: options.onDeleteEmbed,
      onPageChanged: () => this.#layout.pageChanged(),
      onStateChanged: () => this.#updateChrome(),
      renderIcon: (element, icon) => setIcon(element, icon),
      renderer: this.#renderer,
      sceneStore: this.#store,
      selectionEdgeDrag: {
        begin: () => this.#layout.beginSelectionEdgeDrag(),
        finish: (outcome) => this.#layout.finishSelectionEdgeDrag(outcome),
        setBottomEdge: (active) => this.#layout.setSelectionBottomEdge(active),
        update: (pointer) => this.#layout.updateSelectionEdgeDrag(pointer),
      },
      scrollOwner,
      startupTool: options.startupTool,
    });
    scrollBinding = bindActiveSceneScrollOwner({
      initialOwner: scrollOwner,
      invalidate: () => this.#renderer.invalidateLayout(),
      ownerWindow,
      ...(options.scrollOwner === undefined ? {} : { provider: options.scrollOwner }),
      root: options.root,
      transfer: (owner) => this.#controller.transferScrollOwner(owner),
    });
    this.#removeViewportListeners = () => scrollBinding?.dispose();
    this.#controller.setEnabled(false);
    this.#chrome = beginEditorChromeMount(this.#chromeHost, this.#controller.chromeProps());
    this.#removeInputListeners = attachActiveSceneInputListeners(this.#renderer, this.#controller);
    this.#layout = new ActiveEditorLayout({
      chromeHost: this.#chromeHost,
      container: this.#container,
      onLayout: (layout) => this.#controller.setLayout(layout),
      onReady: () => {
        if (this.#initialSceneReadiness.markLayoutReady()) this.#completePreviewHandoff();
      },
      onResize: (update) => this.#controller.applyResize(update),
      onZoom: (zoom) => this.#controller.setZoom(zoom),
      page: () => options.model.page,
      renderer: this.#renderer,
      readResizeAnchor: () => this.#controller.readResizeAnchor(),
      root: options.root,
      storeMaximumBottom: () => options.model.store.getMaximumBottom(),
    });
    this.#unsubscribeStore = options.model.store.subscribe((delta) => this.#applyDelta(delta));
    const readiness = createSceneReadiness(
      this.#chrome,
      () => this.#disposed,
      () => this.#layout.chromeMounted(),
    );
    this.#resolveReady = readiness.resolve;
    this.ready = readiness.ready;
  }

  public disableInput(): void {
    this.#controller.setEnabled(false);
    this.#beginLockTransition();
    this.#layout.suspend();
  }

  public enableInput(): void {
    if (!this.#readyForInput) return;
    this.#cancelLockTransition();
    this.#layout.resume();
    this.#controller.setEnabled(true);
  }

  public restoreAfterFailedLock(): void {
    if (this.#disposed) return;
    this.#cancelLockTransition();
    this.#layout.resume();
  }

  public finishLock(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#beginLockTransition();
    this.#lockPromise ??= this.#finishLockTransition(this.#lockGeneration);
    return this.#lockPromise;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lockGeneration += 1;
    this.#readyForInput = false;
    this.#resolveReady(false);
    this.#controller.setEnabled(false);
    this.#lockDelay.cancel();
    this.#lockLayoutTransition?.cancel();
    this.#lockLayoutTransition = undefined;
    this.#layout.dispose();
    this.#unsubscribeStore();
    this.#removeViewportListeners();
    this.#removeInputListeners();
    this.#controller.dispose();
    this.#chrome.unmount();
    this.#memory.release();
    this.#renderer.destroy();
    this.#previewHandoff.dispose();
    this.#editorChrome.remove();
  }

  public executeAction(action: ContextMenuAction): void {
    this.#controller.executeAction(action);
  }

  public isActionAvailable(action: ContextMenuAction): boolean {
    return this.#controller.isActionAvailable(action);
  }

  public recordMarkdownHistory(): void {
    this.#controller.recordMarkdownHistory();
  }

  public getViewState(): ActiveEditorViewState | undefined {
    if (this.#disposed) return undefined;
    return this.#controller.getViewState();
  }

  public setScheme(scheme: InkbookColorScheme): void {
    this.#renderer.setScheme(scheme);
  }

  public setPreviewSource(source: string): void {
    if (this.#disposed) return;
    this.#refreshPreviewAspectRatio();
    this.#previewReady = this.#previewHandoff.setPreviewSource(source);
  }

  public updateDeviceSettings(settings: InkbookDeviceSettingsV1): void {
    if (this.#disposed) return;
    this.#previewHandoff.updateMotion(settings.motion);
    this.#renderer.setReducedMotion(this.#previewHandoff.reducedMotion);
    this.#root.dataset.inkbookMotion = settings.motion;
    this.#layout.updateMotion(settings.motion);
    this.#controller.updateDeviceSettings(settings);
    this.#updateChrome();
  }

  #applyDelta(delta: StoreDelta): void {
    this.#renderer.applyDelta({
      affected: delta.changes.map((change) => ({
        after: change.after === null ? null : (change.after.element as InkElementV1),
        before: change.before === null ? null : (change.before.element as InkElementV1),
        domains: change.domains,
        id: change.id,
      })),
    });
    this.#memory.evaluate();
    this.#layout.contentChanged();
    this.#updateChrome();
    if (
      !this.#firstStrokeCommitted &&
      delta.changes.some(
        (change) => change.before === null && change.after?.element.kind === "stroke",
      )
    ) {
      this.#firstStrokeCommitted = true;
      this.#onFirstStrokeCommitted?.();
    }
  }

  #beginLockTransition(): void {
    if (this.#disposed || this.#lockStartedAt !== undefined) return;
    const ownerWindow = this.#root.ownerDocument.defaultView;
    if (ownerWindow === null) return;
    this.#lockStartedAt = ownerWindow.performance.now();
    this.#lockGeneration += 1;
    this.#preLockBlockSize = this.#container.style.blockSize;
    this.#preLockViewState = this.#controller.getViewState();
    this.#refreshPreviewAspectRatio();
    this.#lockLayoutTransition = applyLockedFitLayout({
      anchor: this.#controller.readResizeAnchor(),
      applyResize: (update) => this.#controller.applyResize(update),
      container: this.#container,
      maximumBottom: this.#storeMaximumBottom(),
      oldViewState: this.#preLockViewState,
      page: this.#controllerModelPage(),
      reducedMotion: this.#previewHandoff.reducedMotion,
      restoreViewState: (state) => this.#controller.restoreViewState(state),
    });
  }

  #cancelLockTransition(): void {
    if (this.#lockStartedAt === undefined) return;
    this.#lockLayoutTransition?.cancel();
    this.#lockGeneration += 1;
    this.#lockDelay.cancel();
    this.#lockLayoutTransition = undefined;
    this.#lockPromise = undefined;
    this.#lockStartedAt = undefined;
    this.#container.style.removeProperty("transition");
    if (this.#preLockBlockSize !== undefined && this.#preLockViewState !== undefined) {
      restoreActiveLayout({
        anchor: this.#controller.readResizeAnchor(),
        applyResize: (update) => this.#controller.applyResize(update),
        container: this.#container,
        currentViewState: this.#controller.getViewState(),
        restoreViewState: (state) => this.#controller.restoreViewState(state),
        targetBlockSize: this.#preLockBlockSize,
        targetViewState: this.#preLockViewState,
      });
    }
    this.#preLockBlockSize = undefined;
    this.#preLockViewState = undefined;
  }

  async #finishLockTransition(generation: number): Promise<void> {
    const ownerWindow = this.#root.ownerDocument.defaultView;
    if (ownerWindow === null) return;
    const elapsed = ownerWindow.performance.now() - (this.#lockStartedAt ?? 0);
    const reduced = this.#previewHandoff.reducedMotion;
    const remaining = reduced ? 0 : Math.max(0, LOCK_LAYOUT_DURATION_MS - elapsed);
    if (remaining > 0) {
      await this.#lockDelay.wait(remaining);
    }
    if (this.#disposed || generation !== this.#lockGeneration) return;
    await this.#previewReady;
    if (this.#disposed || generation !== this.#lockGeneration) return;
    await new Promise<void>((resolve) => {
      this.#previewHandoff.crossfadeToPreview(this.#editorChrome, resolve, () => {
        const transition = this.#lockLayoutTransition;
        this.#lockLayoutTransition = undefined;
        transition?.finish();
      });
    });
  }

  #controllerModelPage() {
    return this.#model.page;
  }

  #storeMaximumBottom(): number | undefined {
    return this.#model.store.getMaximumBottom();
  }

  #refreshPreviewAspectRatio(): void {
    this.#previewHandoff.setPreviewAspectRatio(
      lockedPageAspectRatio(this.#controllerModelPage(), this.#storeMaximumBottom()),
    );
  }

  #completePreviewHandoff(): void {
    if (this.#disposed) return;
    if (this.#initialViewState !== undefined) {
      this.#controller.restoreViewState(this.#initialViewState);
    }
    this.#previewHandoff.ready(() => {
      if (this.#disposed) return;
      this.#readyForInput = true;
      this.#controller.setEnabled(true);
      this.#renderer.inputSurface.focus({ preventScroll: true });
      this.#resolveReady(true);
    });
  }

  #updateChrome(): void {
    if (this.#disposed) return;
    if (this.#renderer.hasPendingSceneCommit) {
      this.#chromeUpdatePending = true;
      return;
    }
    this.#chromeUpdatePending = false;
    updateActiveSceneChrome(this.#chrome, this.#controller, this.#layout);
  }

  #flushPendingChromeUpdate(): void {
    if (!this.#chromeUpdatePending) return;
    this.#updateChrome();
  }

  #sceneCommitted(): void {
    this.#memory.evaluate();
    this.#flushPendingChromeUpdate();
    if (this.#initialSceneReadiness.markSceneCommitted()) this.#completePreviewHandoff();
  }
}

function createSceneInputHandlers(
  controller: () => ActiveEditorController | undefined,
): SceneInputHandlers {
  return {
    contextmenu: (event) => controller()?.handleContextMenu(event),
    keydown: (event) => controller()?.handleKeyDown(event),
    pointercancel: (event) => controller()?.handlePointerCancel(event),
    pointerdown: (event) => controller()?.handlePointerDown(event),
    pointermove: (event) => controller()?.handlePointerMove(event),
    pointerup: (event) => controller()?.handlePointerUp(event),
    wheel: (event) => controller()?.handleWheel(event),
  };
}

function resolveActiveScrollOwner(root: HTMLElement): BrowserScrollElement {
  return (
    resolveScrollOwner(
      root,
      createBrowserScrollDocumentPort(root.ownerDocument),
      browserScrollMetrics,
    ) ?? root
  );
}

function createSceneReadiness(
  chrome: PendingEditorChrome,
  disposed: () => boolean,
  chromeMounted: () => void,
): { readonly ready: Promise<boolean>; readonly resolve: (ready: boolean) => void } {
  let resolve = (_ready: boolean): void => undefined;
  const layoutReady = new Promise<boolean>((complete) => {
    resolve = complete;
  });
  return {
    ready: chrome.ready.then((mounted) => {
      if (!mounted || disposed()) return false;
      chromeMounted();
      return layoutReady;
    }),
    resolve,
  };
}

function createSceneElements(
  root: HTMLElement,
  motion: InkbookDeviceSettingsV1["motion"],
): {
  readonly chromeHost: HTMLDivElement;
  readonly container: HTMLDivElement;
  readonly editorChrome: HTMLDivElement;
} {
  root.classList.add("inkbook-root");
  root.dataset.inkbookMotion = motion;
  return createActiveSceneChromeElements(root);
}

function createPreviewHandoff(
  container: HTMLElement,
  options: ActiveInkbookSceneOptions,
): ActiveScenePreviewHandoff {
  return new ActiveScenePreviewHandoff({
    container,
    motion: options.deviceSettings.motion,
    preview: options.preview,
    root: options.root,
    ...(options.setPreviewAspectRatio === undefined
      ? {}
      : { setPreviewAspectRatio: options.setPreviewAspectRatio }),
    ...(options.setPreviewSource === undefined
      ? {}
      : { setPreviewSource: options.setPreviewSource }),
  });
}
