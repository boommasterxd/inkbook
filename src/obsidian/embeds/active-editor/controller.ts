import { GestureController, type GesturePreviewStart } from "../../../editor/gestures/public";
import * as EditorInput from "../../../editor/input/index";
import { selectElement } from "../../../editor/selection/public";
import type { SvgSceneRenderer } from "../../../rendering/scene/index";
import type { InkbookEditorChromeProps } from "../../../rendering/ui/editor-chrome";
import type { ToolbarAction, ToolbarLayoutStage, ToolbarState } from "../../../rendering/ui/index";
import type { ContextMenuAction } from "../../menus/index";
import * as Scrolling from "../../scrolling/index";
import type { EditableDocumentModel } from "../vault-document-session";
import type { ActiveEditorActions } from "./controller-actions";
import type { ActiveEditorControllerOptions } from "./controller-types";
import type { CoalescedPointerInput } from "./coalesced-input";
import { ActiveEditorBackgroundSession } from "./background-session";
import { createActiveEditorChromeProps, createChromeCallbacks } from "./controller-chrome";
import { applyInputAction } from "./controller-dispatch";
import type { ActiveEditorMenuController } from "./controller-menu";
import * as ControllerInteractions from "./controller-interactions";
import { createToolbarState, isShapeTool, isTool } from "./controller-helpers";
import { createActiveEditorPreview } from "./controller-previews";
import type { ActiveEditorHistory } from "./history";
import { ActiveEditorHistoryTraversal } from "./history-traversal";
import type { ActiveEditorHandleInteraction } from "./handle-interaction";
import { ActiveEditorNavigation, type ActiveEditorViewState } from "./navigation";
import type { ElementSceneStore } from "./scene-store";
import { ActiveEditorStyleSession } from "./style-session";
import { ActiveEditorLongPressScheduler } from "./long-press";
import type { PreparedElementHistory } from "./prepared-element-history";
import type { ActiveEditorResizeAnchor, ActiveEditorResizeUpdate } from "./layout";
import type { SynchronousClipboardData } from "./clipboard-reader";
import { ActiveEditorKeyboardController } from "./controller-keyboard";
import { ActiveEditorPointerController } from "./controller-pointer";
import * as ControllerTouch from "./controller-touch";
import { ActiveEditorTouchMode, createActiveEditorTouchMode } from "./controller-touch-mode";
import { createActiveEditorSelectionEdgeDrag } from "./controller-selection-edge";
import { ActiveEditorAvailability } from "./controller-availability";
import { ActiveEditorChromeState } from "./controller-chrome-state";
import { ActivePointerCaptureOwner } from "./pointer-capture";
export class ActiveEditorController {
  readonly #actions: ActiveEditorActions;
  readonly #availability: ActiveEditorAvailability;
  readonly #background: ActiveEditorBackgroundSession;
  readonly #captures: ActivePointerCaptureOwner;
  readonly #chromeState: ActiveEditorChromeState;
  readonly #coalesced: CoalescedPointerInput;
  readonly #gestures: GestureController;
  readonly #handles: ActiveEditorHandleInteraction;
  readonly #history: ActiveEditorHistory;
  readonly #historyTraversal: ActiveEditorHistoryTraversal;
  readonly #interruptLayoutForInput: () => void;
  readonly #keyboard: ActiveEditorKeyboardController;
  readonly #pointer: ActiveEditorPointerController;
  readonly #preparedHistory: PreparedElementHistory;
  #input: EditorInput.InputState;
  readonly #longPress: ActiveEditorLongPressScheduler;
  readonly #menus: ActiveEditorMenuController;
  readonly #model: EditableDocumentModel;
  readonly #onLock: () => void;
  readonly #onStateChanged: () => void;
  readonly #ownerWindow: Window;
  readonly #penGuard: Scrolling.PenScrollGuard<Scrolling.BrowserScrollElement>;
  readonly #renderIcon: ActiveEditorControllerOptions["renderIcon"];
  readonly #renderer: SvgSceneRenderer;
  readonly #sceneStore: ElementSceneStore;
  readonly #sliceBudgetMs: () => number;
  #scrollOwner: Scrolling.BrowserScrollElement;
  readonly #styles: ActiveEditorStyleSession;
  readonly #toolbarAction: InkbookEditorChromeProps["onToolbarAction"] = (action, trigger) =>
    this.handleToolbarAction(action, trigger);
  readonly #selectionEdgeDrag: ReturnType<typeof createActiveEditorSelectionEdgeDrag>;
  readonly #navigation: ActiveEditorNavigation;
  #selection: ReadonlySet<string> = new Set();
  readonly #touchMode: ActiveEditorTouchMode;
  #leftHanded: boolean;
  #lastSessionPointer: EditorInput.PointerSample | null = null;
  #lastSessionScreenPointer: EditorInput.PointerSample | null = null;
  readonly #resetForDisable = (): void =>
    ControllerInteractions.resetActiveEditorForDisable(
      [this.#chromeState, this.#menus, this.#handles, this.#captures, this.#gestures],
      [this.#model, this.#navigation, this.#penGuard],
      [() => this.#dispatch({ type: "reset" }), (pointerId) => this.#captures.release(pointerId)],
    );
  public constructor(options: ActiveEditorControllerOptions) {
    this.#model = options.model;
    this.#interruptLayoutForInput = options.interruptLayoutForInput;
    this.#onLock = options.onLock;
    this.#onStateChanged = options.onStateChanged;
    this.#chromeState = new ActiveEditorChromeState(this.#onStateChanged);
    const ownerWindow = options.container.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The active editor requires an owning window.");
    this.#ownerWindow = ownerWindow;
    this.#longPress = new ActiveEditorLongPressScheduler(ownerWindow);
    this.#renderIcon = options.renderIcon;
    this.#renderer = options.renderer;
    this.#captures = new ActivePointerCaptureOwner(options.renderer.inputSurface);
    this.#sceneStore = options.sceneStore;
    this.#sliceBudgetMs = options.sliceBudgetMs ?? (() => 8);
    this.#scrollOwner = options.scrollOwner;
    this.#availability = new ActiveEditorAvailability({
      onDisabled: this.#resetForDisable,
      onStateChanged: this.#onStateChanged,
      setInputInert: (inert) => (this.#renderer.inputSurface.inert = inert),
    });
    this.#history = options.history;
    this.#historyTraversal = new ActiveEditorHistoryTraversal({
      history: this.#history,
      onPendingChanged: (pending) => this.#availability.setPending(pending),
      onStateChanged: this.#onStateChanged,
    });
    this.#background = new ActiveEditorBackgroundSession({
      backgroundSpacing: options.backgroundSpacing,
      history: this.#history,
      model: this.#model,
      onPageChanged: options.onPageChanged,
      onPagePreviewFinish: options.onPagePreviewFinish,
      onPagePreview: options.onPagePreview,
      onStateChanged: this.#onStateChanged,
    });
    this.#styles = new ActiveEditorStyleSession({
      defaults: options.defaults,
      history: this.#history,
      onStateChanged: this.#onStateChanged,
      sceneStore: this.#sceneStore,
      selection: () => this.#selection,
      store: this.#model.store,
    });
    this.#touchMode = createActiveEditorTouchMode(options);
    this.#leftHanded = options.deviceSettings.leftHandedToolbar;
    this.#input = EditorInput.createInputState({
      activeTool: options.startupTool,
      deviceFingerDrawingEnabled: options.deviceSettings.fingerDrawingEnabled,
    });
    if (isShapeTool(options.startupTool)) this.#chromeState.selectShape(options.startupTool);
    this.#penGuard = new Scrolling.PenScrollGuard({
      listeners: Scrolling.browserScrollListeners,
      metrics: Scrolling.browserScrollMetrics,
      scheduler: Scrolling.createAnimationFrameScheduler(ownerWindow),
    });
    this.#navigation = ControllerInteractions.createControllerNavigation({
      controller: options,
      getInput: () => this.#input,
      renderSelection: () => this.#handles.renderSelection(),
      scrollOwner: this.#scrollOwner,
      setInput: (input) => {
        this.#input = input;
      },
    });
    this.#selectionEdgeDrag = createActiveEditorSelectionEdgeDrag({
      navigation: this.#navigation,
      ownerWindow,
      scrollOwner: () => this.#scrollOwner,
    });
    const interactions = ControllerInteractions.createActiveEditorInteractions({
      controller: options,
      dispatchMove: (pointer) => this.#dispatch({ type: "pointer-move", ...pointer }),
      history: this.#history,
      isAttached: () => this.#availability.attached,
      isEnabled: () => this.#availability.acceptsInput,
      lastSessionPointer: () => this.#lastSessionPointer,
      navigation: this.#navigation,
      onPasteCommitted: () => this.#configureTool("select"),
      onPendingChanged: (pending) => this.#availability.setPending(pending),
      ownerWindow,
      selection: () => this.#selection,
      setSelection: (selection) => this.#setSelection(selection),
    });
    this.#actions = interactions.actions;
    this.#coalesced = interactions.coalesced;
    this.#handles = interactions.handles;
    this.#menus = interactions.menus;
    this.#preparedHistory = interactions.preparedHistory;
    this.#keyboard = this.#createKeyboardController(options);
    this.#pointer = this.#createPointerController(ownerWindow);
    this.#gestures = this.#createGestureController();
    createChromeCallbacks(
      [this.#actions, this.#background, this.#chromeState, this.#styles],
      [() => this.#input.activeTool, (tool) => this.#configureTool(tool)],
      [this.#menus, this.#model, () => this.#selection.size, this.#renderIcon],
    );
  }
  public chromeProps() {
    return createActiveEditorChromeProps(
      [this.#chromeState, this.#styles],
      [
        this.#input.activeTool,
        this.#leftHanded,
        this.#toolbarAction,
        this.#ownerWindow.document,
        this.#renderIcon,
        this.toolbarState(),
      ],
    );
  }
  public dispose(): void {
    this.#availability.setEnabled(false);
    this.#captures.releaseAll();
    this.#actions.dispose();
    this.#gestures.cancelActivePreview();
    this.#longPress.dispose();
    this.#menus.dispose();
    this.#handles.dispose();
    this.#preparedHistory.dispose();
    this.#historyTraversal.dispose();
    this.#keyboard.dispose();
    this.#penGuard.stop();
    this.#navigation.dispose();
    this.#model.setGestureActive(false);
  }
  readonly handleContextMenu = (event: MouseEvent): void => this.#pointer.handleContextMenu(event);
  public handleKeyDown(event: KeyboardEvent): void {
    if (!this.#availability.acceptsInput) return;
    if (this.#keyboard.handleKeyDown(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  public readonly handleDocumentKeyDown = (event: KeyboardEvent): boolean =>
    this.#availability.acceptsInput && this.#keyboard.handleDocumentKeyDown(event);
  readonly handlePointerCancel = (event: PointerEvent) => this.#pointer.handlePointerCancel(event);
  public handlePointerBoundary(pointerOver: boolean): void {
    this.#keyboard.setPointerOver(pointerOver);
    if (pointerOver) void this.#actions.refreshPasteAvailability();
  }
  readonly handlePointerDown = (event: PointerEvent) => this.#pointer.handlePointerDown(event);
  readonly handlePointerMove = (event: PointerEvent) => this.#pointer.handlePointerMove(event);
  readonly handlePointerUp = (event: PointerEvent): void => this.#pointer.handlePointerUp(event);
  public preparePrimaryTouchStart(): void {
    this.#navigation.cancelPanMomentum();
    if (ControllerTouch.isTouchInteraction(this.#input.interaction))
      this.#dispatch({ type: "reset" });
  }
  public readonly blocksNativeTouchScrolling = (): boolean =>
    this.#handles.activePointerType === "touch" ||
    ControllerTouch.touchInteractionBlocksNativeScroll(this.#input.interaction);
  public recoverInterruptedTouch(): void {
    this.preparePrimaryTouchStart();
    this.#captures.releaseAll();
    this.#penGuard.stop();
  }
  public recoverTouchTerminal(pointerId: number): void {
    if (ControllerTouch.touchInteractionOwnsPointer(this.#input.interaction, pointerId)) {
      this.#pointer.cancelPointer(pointerId);
    }
  }
  public handleToolbarAction(action: ToolbarAction, trigger?: HTMLButtonElement): void {
    if (!this.#availability.acceptsInput) return;
    if (isTool(action)) {
      this.#configureTool(this.#chromeState.activateTool(action));
      return;
    }
    if (action === "undo") this.#historyTraversal.undo();
    else if (action === "redo") this.#historyTraversal.redo();
    else if (action === "lock") {
      this.#menus.closeToolbar();
      this.#onLock();
    } else if (action === "shape-picker" || action === "overflow" || action === "style")
      this.#menus.toggleToolbar(action === "shape-picker" ? "shape" : action, trigger);
    else if (action === "finger-drawing") this.#toggleFingerDrawing();
    else if (
      (action === "delete" || action === "copy" || action === "cut" || action === "paste") &&
      this.#actions.isAvailable(action)
    )
      this.#actions.execute(action);
  }
  readonly handleLostPointerCapture = (event: PointerEvent) =>
    this.#captures.runIfOwned(event.pointerId, () => this.#pointer.handleLostPointerCapture(event));
  public handleWheel(event: WheelEvent): void {
    if (!this.#availability.acceptsInput) return;
    if (this.#navigation.updateWheel(event)) event.preventDefault();
  }
  public handlePaste(data: SynchronousClipboardData | null): boolean {
    if (!this.#availability.acceptsInput) return false;
    return this.#keyboard.handlePaste(data);
  }
  public readonly isActionAvailable = (action: ContextMenuAction): boolean =>
    this.#actions.isAvailable(action);
  public readonly executeAction = (action: ContextMenuAction): void =>
    this.#actions.execute(action);
  public setEnabled(enabled: boolean): void {
    this.#availability.setEnabled(enabled);
    if (enabled) void this.#actions.refreshPasteAvailability();
  }
  public setLayout(layout: ToolbarLayoutStage): void {
    this.#chromeState.setLayout(layout);
  }
  public setZoom(zoom: number): void {
    this.#navigation.setZoom(zoom);
  }
  public applyResize(update: ActiveEditorResizeUpdate): boolean {
    return this.#navigation.applyResize(update);
  }
  public getViewState(): ActiveEditorViewState {
    return this.#navigation.getViewState();
  }
  public readResizeAnchor(): ActiveEditorResizeAnchor | undefined {
    return this.#navigation.readResizeAnchor();
  }
  public recordMarkdownHistory(): void {
    if (this.#availability.acceptsInput) this.#keyboard.recordMarkdownHistory();
  }
  public restoreViewState(state: ActiveEditorViewState): boolean {
    return this.#navigation.restoreViewState(state);
  }
  public transferScrollOwner(scrollOwner: Scrolling.BrowserScrollElement): boolean {
    if (scrollOwner === this.#scrollOwner) return false;
    this.#penGuard.stop();
    if (!this.#navigation.transferScrollOwner(scrollOwner)) return false;
    this.#scrollOwner = scrollOwner;
    return true;
  }
  public updateDeviceSettings(settings: ActiveEditorControllerOptions["deviceSettings"]): void {
    const changed =
      settings.fingerDrawingEnabled !== this.#touchMode.available ||
      settings.leftHandedToolbar !== this.#leftHanded;
    this.#touchMode.updateAvailable(settings.fingerDrawingEnabled);
    this.#leftHanded = settings.leftHandedToolbar;
    this.#input = EditorInput.reduceInput(this.#input, {
      type: "configure",
      deviceFingerDrawingEnabled: settings.fingerDrawingEnabled,
    }).state;
    if (changed) this.#onStateChanged();
  }
  public toolbarState(): ToolbarState {
    return createToolbarState({
      activeTool: this.#input.activeTool,
      canRedo: this.#availability.acceptsInput && this.#history.canRedo,
      canUndo: this.#availability.acceptsInput && this.#history.canUndo,
      canPaste: this.#actions.canPaste,
      fingerDrawingEnabled: this.#touchMode.enabled,
      fingerDrawingAvailable: this.#touchMode.available,
      hasSelection: this.#selection.size > 0,
      openFlyout: this.#chromeState.openFlyout,
    });
  }
  #beginPreview(start: GesturePreviewStart) {
    if (this.#chromeState.closeFlyout()) this.#menus.closeToolbar();
    const pageStart = { ...start, pointer: this.#navigation.pageSample(start.pointer) };
    return this.#coalesced.wrapProjected(
      createActiveEditorPreview(pageStart, {
        defaults: this.#styles.defaults,
        history: this.#history,
        model: this.#model,
        ownerWindow: this.#ownerWindow,
        pageToScreen: (point) => this.#navigation.localPointFromPage(point),
        pageToViewport: (point) => this.#navigation.screenPoint(point),
        viewportToPage: ({ x, y }) => this.#navigation.pagePoint({ clientX: x, clientY: y }),
        preparedHistory: this.#preparedHistory,
        renderer: this.#renderer,
        sceneStore: this.#sceneStore,
        sliceBudgetMs: this.#sliceBudgetMs,
        selection: () => this.#selection,
        selectionEdgeDrag: this.#selectionEdgeDrag,
        setSelection: (selection) => this.#setSelection(selection),
        zoom: () => this.#navigation.zoom,
      }),
      (sample) => ({ ...this.#navigation.pageSample(sample), time: sample.time }),
    );
  }
  #capturePointer(pointerId: number): void {
    this.#captures.capture(pointerId);
    const last = this.#lastSessionPointer;
    if (last?.pointerId === pointerId) this.#penGuard.begin(last.pointerType, this.#scrollOwner);
  }
  #configureTool(tool: EditorInput.EditorTool): void {
    const changed = this.#input.activeTool !== tool;
    this.#input = EditorInput.reduceInput(this.#input, {
      type: "configure",
      activeTool: tool,
    }).state;
    const closedFlyout = this.#chromeState.closeFlyout();
    if (closedFlyout) this.#menus.closeToolbar();
    if (changed && !closedFlyout) this.#onStateChanged();
  }
  #cancelActiveGesture(): boolean {
    if (this.#input.interaction !== undefined) {
      this.#dispatch({ type: "reset" });
      return true;
    }
    const pointerId = this.#handles.activePointerId;
    if (pointerId === undefined || !this.#handles.cancel(pointerId)) return false;
    this.#captures.release(pointerId);
    this.#navigation.finish();
    this.#penGuard.stop();
    return true;
  }
  #interruptForInput(): void {
    this.#interruptLayoutForInput();
    this.#chromeState.closeFlyout();
    this.#menus.closeToolbar();
  }
  #createGestureController(): GestureController {
    return new GestureController({
      activateTemporaryEraser: () => this.#onStateChanged(),
      beginPinch: () => this.#navigation.begin(),
      beginPreview: (start) => this.#beginPreview(start),
      cancelLongPress: (pointerId) => this.#longPress.cancel(pointerId),
      capturePointer: (pointerId) => this.#capturePointer(pointerId),
      clearSelection: () => this.#setSelection(new Set()),
      finishPinch: () => this.#navigation.finish(),
      openContextMenu: (source, position) =>
        this.#menus.openFromSource(
          source,
          source === "keyboard" ? position : this.#navigation.pagePointFromScreen(position),
        ),
      panPage: (screenDeltaX) => this.#navigation.pan(ControllerTouch.touchPanDelta(screenDeltaX)),
      releasePointer: (pointerId) => this.#captures.release(pointerId),
      restoreTemporaryTool: () => this.#onStateChanged(),
      revertNavigation: (kind) =>
        kind === "page-pan" ? this.#navigation.revert() : this.#navigation.finish(),
      revertPinch: () => this.#navigation.revert(),
      scheduleLongPress: (pointerId, delayMs) =>
        this.#longPress.schedule(pointerId, delayMs, () =>
          this.#dispatch({ type: "long-press", pointerId }),
        ),
      scrollNote: () => undefined,
      selectElement: (elementId, mode) =>
        this.#setSelection(selectElement(this.#selection, elementId, mode)),
      updatePinch: (anchor, factor) => this.#navigation.updatePinchScreen(anchor, factor),
    });
  }
  #createKeyboardController(
    options: ActiveEditorControllerOptions,
  ): ActiveEditorKeyboardController {
    return new ActiveEditorKeyboardController({
      activeElement: () => this.#ownerWindow.document.activeElement,
      actions: this.#actions,
      cancelGesture: () => this.#cancelActiveGesture(),
      clearSelection: () => this.#setSelection(new Set()),
      closeFlyout: () => {
        const closed = this.#chromeState.closeFlyout();
        if (closed) this.#menus.closeToolbar();
        return closed;
      },
      history: this.#history,
      lastScreenPointer: () => this.#lastSessionScreenPointer,
      navigation: this.#navigation,
      ownerDocument: this.#ownerWindow.document,
      onFeedback: options.onFeedback,
      onPendingChanged: (pending) => this.#availability.setPending(pending),
      openKeyboardMenu: (position) =>
        this.#dispatch({ type: "context-menu", source: "keyboard", ...position }),
      selectionSize: () => this.#selection.size,
    });
  }
  #createPointerController(ownerWindow: Window): ActiveEditorPointerController {
    return new ActiveEditorPointerController({
      beginHandlePointer: (pointerType) => {
        this.#navigation.begin();
        this.#penGuard.begin(pointerType, this.#scrollOwner);
      },
      coalesced: this.#coalesced,
      capturePointer: (pointerId) => this.#capturePointer(pointerId),
      dispatch: (action) => this.#dispatch(action),
      finishHandlePointer: () => {
        this.#navigation.finish();
        this.#penGuard.stop();
      },
      getInput: () => this.#input,
      handles: this.#handles,
      interruptForInput: () => this.#interruptForInput(),
      isEnabled: () => this.#availability.acceptsInput,
      menus: this.#menus,
      navigation: this.#navigation,
      ownerWindow,
      renderer: this.#renderer,
      releasePointer: (pointerId) => this.#captures.release(pointerId),
      sceneStore: this.#sceneStore,
      selection: () => this.#selection,
      setLastPointer: (page, screen) => {
        this.#lastSessionPointer = page;
        this.#lastSessionScreenPointer = screen;
      },
    });
  }
  #dispatch(action: EditorInput.InputAction): void {
    const input = applyInputAction(
      this.#input,
      action,
      this.#gestures,
      this.#model,
      this.#penGuard,
      this.#navigation,
    );
    const hasSelection = this.#selection.size > 0;
    this.#input = input.hasSelection === hasSelection ? input : { ...input, hasSelection };
  }
  #setSelection(selection: ReadonlySet<string>): void {
    if (selection === this.#selection) return;
    this.#selection = selection;
    this.#input = { ...this.#input, hasSelection: selection.size > 0 };
    this.#handles.renderSelection();
    this.#onStateChanged();
  }
  #toggleFingerDrawing(): void {
    this.#input = this.#touchMode.toggle(this.#input);
    this.#onStateChanged();
  }
}
