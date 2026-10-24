import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";

import type { InkbookDeviceSettingsV2 } from "../../../domain/settings/types";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { StoreDelta } from "../../../domain/store/public";
import { SvgSceneRenderer } from "../../../rendering/scene/index";
import { beginEditorChromeMount, type PendingEditorChrome } from "./editor-chrome-loader";
import type { ContextMenuAction } from "../../menus/index";
import type { BrowserScrollElement } from "../../scrolling/index";
import type { InkbookColorScheme } from "../../theme/color-scheme";
import type { ActiveEditorController } from "../active-editor/controller";
import { ActiveEditorLayout } from "../active-editor/layout/layout";
import type { ActiveEditorViewState } from "../active-editor/navigation/navigation";
import type { ElementSceneStore } from "../active-editor/scene-store";
import { createActiveSceneController } from "./active-scene-controller";
import { ActiveScenePreviewHandoff } from "./active-scene-handoff";
import { ActiveSceneMemoryBinding } from "./active-scene-memory";
import { ActiveScenePrewarmBinding } from "./active-scene-prewarm";
import { ActiveSceneTimeout } from "./active-scene-timeout";
import { attachActiveSceneInputListeners, createSceneInputHandlers } from "./active-scene-input";
import type { ActiveSceneScrollBinding } from "./active-scene-scroll";
import {
  applyLockedFitLayout,
  LOCK_PRESENTATION_DURATION_MS,
  restoreActiveLayout,
  type LockedFitTransition,
} from "./active-scene-lock";
import { updateActiveSceneChrome } from "./active-scene-chrome";
import { readActiveSceneLayout } from "./active-scene-viewport";
import { readNavigationLayout } from "../active-editor/navigation/navigation-layout";
import { createSceneReadiness, InitialSceneReadiness } from "./initial-scene-readiness";
import {
  bindSceneScrollOwner,
  createInitialSceneRuntime,
  resolveActiveScrollOwner,
} from "./active-scene-runtime";
import type { TransitionScrollStability } from "../presentation/transition-scroll-stability";
import type { EditableDocumentModel } from "../document-session/vault-document-session";
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
  readonly #hostZoomScroll: ActiveInkbookSceneOptions["hostZoomScroll"];
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
  readonly #prewarm: ActiveScenePrewarmBinding;
  readonly #onFirstStrokeCommitted: (() => void) | undefined;
  #firstStrokeCommitted = false;
  #chromeUpdatePending = false;
  #committedHistory = { canUndo: false, canRedo: false };
  readonly #removeViewportListeners: () => void;
  #readyForInput = false;
  #surfaceFailed = false;
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
    this.#hostZoomScroll = options.hostZoomScroll;
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
    this.#prewarm = new ActiveScenePrewarmBinding(options.root, (enabled) =>
      this.#renderer.setDocumentPrewarmEnabled(enabled),
    );
    this.#bindPreviewHandoff(options.releasePreview);
    this.#memory.attach(this.#renderer);
    this.#renderer.setScheme(options.scheme);
    this.#renderer.setSelectionHighlightsEnabled(options.selectionHighlightsEnabled ?? true);
    this.#controller = controller = createActiveSceneController(options, {
      container: this.#container,
      layout: () => this.#layout,
      renderer: this.#renderer,
      scrollOwner,
      store: this.#store,
      updateChrome: () => this.#updateChrome(),
    });
    scrollBinding = bindSceneScrollOwner(
      scrollOwner,
      ownerWindow,
      options,
      this.#renderer,
      this.#controller,
      (owner) => this.#layout.consumeOwnZoomScroll(owner),
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
      readHostGeometryRevision: () => options.hostZoomScroll?.geometryRevision ?? 0,
      beginScrollStability: () => this.#transitionScrollStability.begin(),
      chromeHost: this.#chromeHost,
      container: this.#container,
      onLayout: (layout) => this.#controller.setLayout(layout),
      onReady: () => {
        if (this.#initialSceneReadiness.markLayoutReady()) this.#renderer.invalidateLayout(true);
      },
      onResize: (update) => {
        this.#hostZoomScroll?.cancel();
        return this.#controller.applyResize(update);
      },
      onZoom: (zoom) => {
        this.#hostZoomScroll?.cancel();
        this.#controller.setZoom(zoom);
      },
      page: () => options.model.page,
      renderer: this.#renderer,
      readResizeAnchor: (measurement) => this.#controller.readResizeAnchor(measurement),
      readNavigationLayout: () =>
        readNavigationLayout(this.#container, scrollBinding?.current() ?? scrollOwner),
      root: options.root,
      storeMaximumBottom: () => options.model.store.getMaximumBottom(),
    });
    this.#unsubscribeStore = options.model.store.subscribe((delta) =>
      this.#applyDelta(delta, options.history.isReplaying),
    );
    const readiness = createSceneReadiness(
      this.#chrome,
      () => this.#disposed || this.#surfaceFailed,
      () => this.#layout.chromeMounted(),
    );
    this.#resolveReady = readiness.resolve;
    this.ready = readiness.ready;
  }

  public disableInput(): void {
    this.#prewarm.setEnabled(false);
    this.#hostZoomScroll?.cancel();
    this.#controller.setEnabled(false);
    this.#layout.suspend();
    this.#beginLockTransition();
  }

  #bindPreviewHandoff(releasePreview: (() => void) | undefined): void {
    this.#previewHandoff.onSceneReveal = this.#renderer.revealSurface;
    this.#previewHandoff.onReducedMotionChange = this.#updateReducedMotion;
    this.#previewHandoff.onUnlockSettled = () => {
      if (!this.#disposed && !this.#surfaceFailed && this.#lockStartedAt === undefined)
        releasePreview?.();
    };
  }
  public enableInput(): void {
    if (!this.#readyForInput) return;
    this.#cancelLockTransition();
    this.#prewarm.setEnabled(true);
    this.#layout.resume();
    this.#controller.setEnabled(true);
  }
  public restoreAfterFailedLock(): void {
    if (this.#disposed || this.#surfaceFailed) return;
    this.#cancelLockTransition();
    this.#prewarm.setEnabled(true);
    this.#layout.resume();
  }
  public finishLock(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#beginLockTransition();
    if (this.#lockPromise === undefined) {
      const task = this.#finishLockTransition(this.#lockGeneration).catch((error: unknown) => {
        if (this.#lockPromise === task) this.#lockPromise = undefined;
        throw error;
      });
      this.#lockPromise = task;
    }
    return this.#lockPromise;
  }
  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#prewarm.dispose();
    this.#hostZoomScroll?.cancel();
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
    if (!this.#surfaceFailed) this.#controller.executeAction(action);
  }
  public isActionAvailable(action: ContextMenuAction): boolean {
    return !this.#surfaceFailed && this.#controller.isActionAvailable(action);
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
    this.#renderer.setScrollPreloadMarginPx(settings.scrollPreloadMarginPx);
    this.#root.dataset.inkbookMotion = settings.motion;
    this.#layout.updateMotion(settings.motion);
    this.#controller.updateDeviceSettings(settings);
    this.#updateChrome();
  }

  readonly #updateReducedMotion = (reduced: boolean): void => {
    this.#renderer.setReducedMotion(reduced);
    if (reduced) {
      this.#lockLayoutTransition?.finish();
      this.#lockDelay.cancel();
    }
  };

  public updateSelectionHighlights(enabled: boolean): void {
    if (!this.#disposed) this.#renderer.setSelectionHighlightsEnabled(enabled);
  }

  public updateSnappingSettings(settings: ActiveInkbookSceneOptions["snapping"]): void {
    if (this.#disposed) return;
    this.#controller.updateSnappingSettings(settings);
  }

  #applyDelta(delta: StoreDelta, historyReplay: boolean): void {
    this.#renderer.applyDelta({
      historyReplay,
      affected: delta.changes.map((change) => ({
        after: change.after === null ? null : (change.after.element as InkElementV1),
        afterBounds: change.after?.bounds ?? null,
        before: change.before === null ? null : (change.before.element as InkElementV1),
        beforeBounds: change.before?.bounds ?? null,
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
      surfaceThemeRoot: this.#root,
      onSurfaceFailure: () => this.#failSurface(options.onLock),
      workScheduler: options.workScheduler,
      deferInitialOverscan: true,
      scrollPreloadMarginPx: options.deviceSettings.scrollPreloadMarginPx,
      inputHandlers: createSceneInputHandlers(controller),
      isInputActive: () => options.model.isGestureActive?.() ?? true,
      waitForBackground: () => options.model.waitForBackground?.(),
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

  #failSurface(onLock: () => void): void {
    if (this.#disposed || this.#surfaceFailed) return;
    this.#surfaceFailed = true;
    this.#prewarm.setEnabled(false);
    this.#readyForInput = false;
    this.#controller.setEnabled(false);
    this.#layout.suspend();
    this.#resolveReady(false);
    onLock();
  }
  #beginLockTransition(): void {
    if (this.#disposed || this.#surfaceFailed || this.#lockStartedAt !== undefined) return;
    this.#prewarm.setEnabled(false);
    const ownerWindow = this.#root.ownerDocument.defaultView;
    if (ownerWindow === null) return;
    this.#lockStartedAt = ownerWindow.performance.now();
    this.#lockGeneration += 1;
    this.#preLockBlockSize =
      this.#previewHandoff.stopUnlockHeight() ?? this.#container.style.blockSize;
    this.#preLockViewState = this.#controller.getViewState();
    this.#lockLayoutTransition = applyLockedFitLayout({
      workScheduler: this.#workScheduler,
      anchor: this.#controller.readResizeAnchor(),
      applyResize: (update) => this.#controller.applyResize(update),
      beginScrollStability: (minimumRangeReserve) =>
        this.#transitionScrollStability.begin(minimumRangeReserve),
      container: this.#container,
      maximumBottom: this.#model.store.getMaximumBottom(),
      oldViewState: this.#preLockViewState,
      page: this.#model.page,
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
    this.#previewHandoff.releaseHiddenPreview();
  }

  async #finishLockTransition(generation: number): Promise<void> {
    const ownerWindow = this.#root.ownerDocument.defaultView;
    if (ownerWindow === null) return;
    const transition = this.#lockLayoutTransition;
    try {
      const elapsed = ownerWindow.performance.now() - (this.#lockStartedAt ?? 0);
      const reduced = this.#previewHandoff.reducedMotion;
      const remaining =
        reduced || this.#surfaceFailed ? 0 : Math.max(0, LOCK_PRESENTATION_DURATION_MS - elapsed);
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

  #completePreviewHandoff(): void {
    if (this.#disposed || this.#surfaceFailed) return;
    this.#previewHandoff.ready(
      () => {
        if (this.#disposed || this.#surfaceFailed) return;
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
    this.#chromeUpdatePending = this.#renderer.hasPendingSceneCommit;
    if (this.#chrome === undefined) return;
    const props = this.#controller.chromeProps();
    const state = props.toolbarState;
    // New history actions wait for committed content; feedback and disabling never do.
    if (!this.#chromeUpdatePending)
      this.#committedHistory = { canUndo: state.canUndo, canRedo: state.canRedo };
    const history = {
      canUndo: state.canUndo && this.#committedHistory.canUndo,
      canRedo: state.canRedo && this.#committedHistory.canRedo,
    };
    updateActiveSceneChrome(
      this.#chrome,
      { chromeProps: () => ({ ...props, toolbarState: { ...state, ...history } }) },
      this.#layout,
    );
  }

  #flushPendingChromeUpdate(): void {
    if (!this.#chromeUpdatePending) return;
    this.#updateChrome();
  }

  #sceneCommitted(): void {
    if (this.#surfaceFailed) return;
    this.#memory.evaluate();
    this.#layout.sceneCommitted();
    this.#flushPendingChromeUpdate();
    if (!this.#renderer.hasPendingSceneCommit && this.#initialSceneReadiness.markSceneCommitted())
      this.#completePreviewHandoff();
  }
}
