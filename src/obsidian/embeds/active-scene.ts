import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { setIcon } from "obsidian";

import type { InkbookDeviceSettingsV2 } from "../../domain/settings/types";
import type { InkElementV1 } from "../../domain/schema/public";
import type { StoreDelta } from "../../domain/store/public";
import { SvgSceneRenderer, type SceneInputHandlers } from "../../rendering/scene/index";
import { beginEditorChromeMount, type PendingEditorChrome } from "./editor-chrome-loader";
import type { ContextMenuAction } from "../menus/index";
import { createOwnedMenuFactory } from "../menus/index";
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
import type { ActiveSceneScrollBinding } from "./active-scene-scroll";
import {
  applyLockedFitLayout,
  LOCK_PRESENTATION_DURATION_MS,
  restoreActiveLayout,
  type LockedFitTransition,
} from "./active-scene-lock";
import { updateActiveSceneChrome } from "./active-scene-chrome";
import { readActiveSceneLayout } from "./active-scene-viewport";
import { readNavigationLayout } from "./active-editor/navigation-layout";
import { createSceneReadiness, InitialSceneReadiness } from "./initial-scene-readiness";
import { bindSceneScrollOwner, createInitialSceneRuntime } from "./active-scene-runtime";
import type { TransitionScrollStability } from "./transition-scroll-stability";
import type { EditableDocumentModel } from "./vault-document-session";
import type { ActiveInkbookSceneOptions } from "./active-scene-types";

export { ActiveScenePreviewHandoff } from "./active-scene-handoff";
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
  readonly #initialSceneReadiness = new InitialSceneReadiness();
  readonly #resolveReady: (ready: boolean) => void;
  readonly #renderer: SvgSceneRenderer;
  readonly #root: HTMLElement;
  readonly #workScheduler: WorkScheduler;
  readonly #store: ElementSceneStore;
  readonly #transitionScrollStability: TransitionScrollStability;
  readonly #unsubscribeStore: () => void;
  public readonly ready: Promise<boolean>;

  public constructor(options: ActiveInkbookSceneOptions) {
    this.#root = options.root;
    this.#workScheduler = options.workScheduler;
    this.#model = options.model;
    this.#onFirstStrokeCommitted = options.onFirstStrokeCommitted;
    const scrollOwner = options.scrollOwner?.() ?? resolveActiveScrollOwner(options.root);
    const ownerWindow = options.root.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The active scene requires an owning window.");
    let scrollBinding: ActiveSceneScrollBinding | undefined;
    const initial = createInitialSceneRuntime(
      options,
      ownerWindow,
      () => scrollBinding?.current() ?? scrollOwner,
    );
    const elements = initial.elements;
    this.#transitionScrollStability = initial.stability;
    this.#chromeHost = elements.chromeHost;
    this.#container = elements.container;
    this.#editorChrome = elements.editorChrome;
    this.#previewHandoff = initial.handoff;
    this.#memory = new ActiveSceneMemoryBinding(options.model);
    this.#store = this.#memory.store;
    this.#lockDelay = new ActiveSceneTimeout(ownerWindow);

    let controller: ActiveEditorController | undefined;
    this.#renderer = this.#createRenderer(
      options,
      () => controller,
      () => scrollBinding?.current() ?? scrollOwner,
    );
    this.#memory.attach(this.#renderer);
    this.#renderer.setScheme(options.scheme);
    this.#renderer.setSelectionHighlightsEnabled(options.selectionHighlightsEnabled ?? true);
    this.#controller = controller = this.#createController(options, scrollOwner);
    scrollBinding = bindSceneScrollOwner(
      scrollOwner,
      ownerWindow,
      options,
      this.#renderer,
      this.#controller,
    );
    this.#removeViewportListeners = () => scrollBinding?.dispose();
    this.#controller.setEnabled(false);
    this.#chrome = beginEditorChromeMount(this.#chromeHost, this.#controller.chromeProps());
    this.#removeInputListeners = attachActiveSceneInputListeners(
      this.#renderer,
      this.#controller,
      this.#root,
    );
    this.#layout = new ActiveEditorLayout({
      workScheduler: options.workScheduler,
      beginScrollStability: () => this.#transitionScrollStability.begin(),
      chromeHost: this.#chromeHost,
      container: this.#container,
      onLayout: (layout) => this.#controller.setLayout(layout),
      onReady: () => {
        if (this.#initialSceneReadiness.markLayoutReady()) this.#renderer.invalidateLayout(true);
      },
      onResize: (update) => this.#controller.applyResize(update),
      onZoom: (zoom) => this.#controller.setZoom(zoom),
      page: () => options.model.page,
      renderer: this.#renderer,
      readResizeAnchor: () => this.#controller.readResizeAnchor(),
      readNavigationLayout: () =>
        readNavigationLayout(this.#container, scrollBinding?.current() ?? scrollOwner),
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

  #createController(
    options: ActiveInkbookSceneOptions,
    scrollOwner: BrowserScrollElement,
  ): ActiveEditorController {
    return new ActiveEditorController({
      workScheduler: options.workScheduler,
      applyZoomLayout: (update) => this.#layout.applyZoom(update),
      onNavigationLayout: (layout) => this.#layout.adoptNavigationLayout(layout),
      backgroundSpacing: options.backgroundSpacing,
      container: this.#container,
      confirmEraseAll: options.confirmEraseAll,
      defaults: options.defaults,
      deviceSettings: options.deviceSettings,
      history: options.history,
      interruptLayoutForInput: () => this.#layout.interruptForInput(),
      ...(options.keymap === undefined ? {} : { keymap: options.keymap }),
      ...(options.createPhoneSheetHost === undefined
        ? {}
        : { createPhoneSheetHost: options.createPhoneSheetHost }),
      menuFactory:
        options.menuFactory ??
        createOwnedMenuFactory({
          workScheduler: options.workScheduler,
          anchor: options.root,
          ...(options.keymap === undefined ? {} : { keymap: options.keymap }),
          ...(options.createPhoneSheetHost === undefined
            ? {}
            : { createPhoneSheetHost: options.createPhoneSheetHost }),
        }),
      model: options.model,
      onLock: options.onLock,
      onFeedback: options.onFeedback,
      onCopyEmbed: options.onCopyEmbed,
      onDeleteEmbed: options.onDeleteEmbed,
      onOpenSettings: options.onOpenSettings,
      onOpenShortcuts: options.onOpenShortcuts,
      onPageChanged: () => this.#layout.pageChanged(),
      onPagePreviewFinish: (committed) => this.#layout.finishPagePreview(committed),
      onPagePreview: (page) => this.#layout.previewPage(page),
      onStateChanged: () => this.#updateChrome(),
      renderIcon: (element, icon) => setIcon(element, icon),
      renderer: this.#renderer,
      sceneStore: this.#store,
      selectionMoveLayout: {
        begin: () => this.#layout.beginSelectionMove(),
        currentHeight: () => this.#layout.currentPageHeight(),
        finish: (committed, previewMaximumBottom) =>
          this.#layout.finishSelectionMove(committed, previewMaximumBottom),
        updateBottom: (maximumBottom) => this.#layout.updateSelectionMoveBottom(maximumBottom),
      },
      scrollOwner,
      snapping: options.snapping,
      startupTool: options.startupTool,
    });
  }

  public disableInput(): void {
    this.#controller.setEnabled(false);
    this.#layout.suspend();
    this.#beginLockTransition();
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
    this.#lockLayoutTransition?.releaseViewportStability();
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
    this.#transitionScrollStability.dispose();
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
    this.#previewReady = this.#previewHandoff.setPreviewSource(source);
  }

  public updateDeviceSettings(settings: InkbookDeviceSettingsV2): void {
    if (this.#disposed) return;
    this.#previewHandoff.updateMotion(settings.motion);
    this.#renderer.setReducedMotion(this.#previewHandoff.reducedMotion);
    this.#root.dataset.inkbookMotion = settings.motion;
    this.#layout.updateMotion(settings.motion);
    this.#controller.updateDeviceSettings(settings);
    this.#updateChrome();
  }

  public updateSelectionHighlights(enabled: boolean): void {
    if (!this.#disposed) this.#renderer.setSelectionHighlightsEnabled(enabled);
  }

  public updateSnappingSettings(settings: ActiveInkbookSceneOptions["snapping"]): void {
    if (this.#disposed) return;
    this.#controller.updateSnappingSettings(settings);
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

  #createRenderer(
    options: ActiveInkbookSceneOptions,
    controller: () => ActiveEditorController | undefined,
    scrollOwner: () => BrowserScrollElement,
  ): SvgSceneRenderer {
    return new SvgSceneRenderer({
      container: this.#container,
      workScheduler: options.workScheduler,
      deferInitialOverscan: true,
      inputHandlers: createSceneInputHandlers(controller),
      isInputActive: () => options.model.isGestureActive?.() ?? true,
      layout: {
        readViewport: () => {
          const snapshot = readActiveSceneLayout(this.#container, scrollOwner(), this.#root);
          controller()?.adoptSceneLayout(snapshot.cursorLayout);
          return snapshot.viewport;
        },
      },
      page: options.model.page,
      onResourceUsageChanged: this.#memory.evaluate,
      onSceneCommitted: () => this.#sceneCommitted(),
      reducedMotion: this.#previewHandoff.reducedMotion,
      store: this.#store,
    });
  }

  #beginLockTransition(): void {
    if (this.#disposed || this.#lockStartedAt !== undefined) return;
    const ownerWindow = this.#root.ownerDocument.defaultView;
    if (ownerWindow === null) return;
    this.#lockStartedAt = ownerWindow.performance.now();
    this.#lockGeneration += 1;
    this.#preLockBlockSize = this.#container.style.blockSize;
    this.#preLockViewState = this.#controller.getViewState();
    this.#lockLayoutTransition = applyLockedFitLayout({
      workScheduler: this.#workScheduler,
      anchor: this.#controller.readResizeAnchor(),
      applyResize: (update) => this.#controller.applyResize(update),
      beginScrollStability: (minimumRangeReserve) =>
        this.#transitionScrollStability.begin(minimumRangeReserve),
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
    const transition = this.#lockLayoutTransition;
    transition?.cancel();
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
    transition?.releaseViewportStability();
    this.#preLockBlockSize = undefined;
    this.#preLockViewState = undefined;
  }

  async #finishLockTransition(generation: number): Promise<void> {
    const ownerWindow = this.#root.ownerDocument.defaultView;
    if (ownerWindow === null) return;
    const transition = this.#lockLayoutTransition;
    try {
      const elapsed = ownerWindow.performance.now() - (this.#lockStartedAt ?? 0);
      const reduced = this.#previewHandoff.reducedMotion;
      const remaining = reduced ? 0 : Math.max(0, LOCK_PRESENTATION_DURATION_MS - elapsed);
      if (remaining > 0) {
        await this.#lockDelay.wait(remaining);
      }
      if (this.#disposed || generation !== this.#lockGeneration) return;
      await Promise.all([this.#previewReady, this.#previewHandoff.ensurePreviewReady()]);
      if (this.#disposed || generation !== this.#lockGeneration) return;
      await new Promise<void>((resolve) => {
        this.#previewHandoff.handoffToPreview(this.#editorChrome, resolve, () => {
          transition?.finish();
        });
      });
    } finally {
      transition?.releaseViewportStability();
      if (this.#lockLayoutTransition === transition) this.#lockLayoutTransition = undefined;
      await this.#transitionScrollStability.waitForSettlement();
    }
  }

  #controllerModelPage() {
    return this.#model.page;
  }

  #storeMaximumBottom(): number | undefined {
    return this.#model.store.getMaximumBottom();
  }

  #completePreviewHandoff(): void {
    if (this.#disposed) return;
    this.#previewHandoff.ready(
      () => {
        if (this.#disposed) return;
        this.#readyForInput = true;
        this.#controller.setEnabled(true);
        this.#renderer.inputSurface.focus({ preventScroll: true });
        this.#resolveReady(true);
        this.#renderer.releaseInitialOverscan();
      },
      () => this.#renderer.sceneCommitProof,
    );
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
    this.#layout.sceneCommitted();
    this.#flushPendingChromeUpdate();
    if (!this.#renderer.hasPendingSceneCommit && this.#initialSceneReadiness.markSceneCommitted())
      this.#completePreviewHandoff();
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
