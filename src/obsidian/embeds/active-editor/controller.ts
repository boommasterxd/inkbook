import type { GestureController, GesturePreviewStart } from "../../../editor/gestures/public";
import * as EditorInput from "../../../editor/input/index";
import { SelectionFrameSession } from "../../../editor/selection/public";
import type { ToolbarAction, ToolbarLayoutStage, ToolbarState } from "../../../rendering/ui/index";
import type { ContextMenuAction } from "../../menus/index";
import * as Scrolling from "../../scrolling/index";
import type { ActiveEditorActions } from "./controller-actions";
import type { ActiveEditorControllerOptions } from "./controller-types";
import type { CoalescedPointerInput } from "./coalesced-input";
import { createActiveEditorChromeProps, createChromeCallbacks } from "./controller-chrome";
import { applyInputAction, configureInputTool } from "./controller-dispatch";
import type { ActiveEditorMenuController } from "./controller-menu";
import * as Interactions from "./controller-interactions";
import * as Helpers from "./controller-helpers";
import { createActiveEditorPreview } from "./controller-previews";
import type { ActiveEditorHistory } from "./history";
import type { ActiveEditorHistoryTraversal } from "./history-traversal";
import type { ActiveEditorHandleInteraction } from "./handle-interaction";
import { ActiveEditorNavigation, type ActiveEditorViewState } from "./navigation";
import { ActiveEditorStyleSession } from "./style-session";
import type { ActiveEditorBackgroundSession } from "./background-session";
import { ActiveEditorLongPressScheduler } from "./long-press";
import type { PreparedElementHistory } from "./prepared-element-history";
import type { ActiveEditorResizeUpdate } from "./layout";
import type { SynchronousClipboardData as ClipboardData } from "./clipboard-reader";
import type { ActiveEditorKeyboardController } from "./controller-keyboard";
import { createActiveEditorInputControllers } from "./controller-input-factory";
import { ActiveEditorPointerController } from "./controller-pointer";
import * as ControllerTouch from "./controller-touch";
import { ActiveEditorTouchMode, createActiveEditorTouchMode } from "./controller-touch-mode";
import { createActiveEditorSelectionEdgeDrag } from "./controller-selection-edge";
import { ActiveEditorAvailability } from "./controller-availability";
import { ActiveEditorChromeState } from "./controller-chrome-state";
import { ActivePointerCaptureOwner } from "./pointer-capture";
import { resolveSnappingPointerOverride } from "./snapping-settings";
import * as ToolCursor from "./tool-cursor-controller";
import { PendingSelection } from "./pending-selection";
export class ActiveEditorController {
  readonly #pendingSelection = new PendingSelection();
  readonly #cursor: ToolCursor.ActiveToolCursorController;
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
  readonly #model: ActiveEditorControllerOptions["model"];
  readonly #onLock: () => void;
  readonly #onStateChanged: () => void;
  readonly #ownerWindow: Window;
  readonly #penGuard: Scrolling.PenScrollGuard<Scrolling.BrowserScrollElement>;
  readonly #renderIcon: ActiveEditorControllerOptions["renderIcon"];
  readonly #renderer: ActiveEditorControllerOptions["renderer"];
  readonly #workScheduler: ActiveEditorControllerOptions["workScheduler"];
  readonly #sceneStore: ActiveEditorControllerOptions["sceneStore"];
  #snapping: ActiveEditorControllerOptions["snapping"];
  #snappingInversion: { readonly inverted: boolean; readonly pointerId: number } | undefined;
  #scrollOwner: Scrolling.BrowserScrollElement;
  readonly #styles: ActiveEditorStyleSession;
  readonly #toolbarAction = this.handleToolbarAction.bind(this);
  readonly #selectionEdgeDrag: ReturnType<typeof createActiveEditorSelectionEdgeDrag>;
  readonly #selectionFrames = new SelectionFrameSession(() => this.#handles.renderSelection());
  readonly #navigation: ActiveEditorNavigation;
  #selection: ReadonlySet<string> = new Set();
  readonly #touchMode: ActiveEditorTouchMode;
  #leftHanded: boolean;
  readonly #resetForDisable = (): void => {
    this.#cursor?.clear();
    this.#snappingInversion = undefined;
    Interactions.resetActiveEditorForDisable(
      [this.#chromeState, this.#menus, this.#handles, this.#captures, this.#gestures],
      [this.#model, this.#navigation, this.#penGuard],
      [() => this.#dispatch({ type: "reset" }), (pointerId) => this.#captures.release(pointerId)],
    );
  };
  public constructor(options: ActiveEditorControllerOptions) {
    [this.#model, this.#interruptLayoutForInput] = [options.model, options.interruptLayoutForInput];
    this.#onLock = options.onLock;
    this.#onStateChanged = () => {
      this.#cursor?.refresh();
      options.onStateChanged();
    };
    this.#chromeState = new ActiveEditorChromeState(this.#onStateChanged);
    const ownerWindow = Helpers.activeEditorWindow(options.container);
    this.#ownerWindow = ownerWindow;
    this.#longPress = new ActiveEditorLongPressScheduler(ownerWindow);
    this.#renderIcon = options.renderIcon;
    this.#workScheduler = options.workScheduler;
    [this.#renderer, this.#sceneStore] = [options.renderer, options.sceneStore];
    this.#captures = new ActivePointerCaptureOwner(options.renderer.inputSurface);
    this.#scrollOwner = options.scrollOwner;
    this.#snapping = structuredClone(options.snapping);
    this.#availability = new ActiveEditorAvailability({
      inputSurface: this.#renderer.inputSurface,
      onDisabled: this.#resetForDisable,
      onStateChanged: this.#onStateChanged,
    });
    this.#history = options.history;
    [this.#background, this.#historyTraversal] = Interactions.createControllerHistorySessions({
      controller: options,
      history: this.#history,
      onPendingChanged: (pending) => this.#availability.setPending(pending),
    });
    this.#styles = new ActiveEditorStyleSession({
      defaults: options.defaults,
      history: this.#history,
      onSelectionGeometryChanged: () => this.#handles.renderSelection(),
      onStateChanged: this.#onStateChanged,
      sceneStore: this.#sceneStore,
      selection: () => this.#selection,
      selectionFrames: this.#selectionFrames,
      store: this.#model.store,
    });
    this.#touchMode = createActiveEditorTouchMode(options);
    this.#leftHanded = options.deviceSettings.leftHandedToolbar;
    this.#input = Interactions.createControllerInputState(options);
    if (Helpers.isShapeTool(options.startupTool))
      this.#chromeState.selectShape(options.startupTool);
    this.#penGuard = Interactions.createControllerPenGuard(this.#workScheduler);
    this.#navigation = Interactions.createControllerNavigation({
      controller: options,
      getInput: () => this.#input,
      isSelectionMoveActive: () => this.#input.interaction?.phase === "element-move",
      renderSelection: () => this.#handles.renderCameraSelection(),
      adoptCursorLayout: (layout) => this.#cursor?.adoptNavigationLayout(layout),
      scrollOwner: this.#scrollOwner,
      setInput: (input) => (this.#input = input),
    });
    this.#selectionEdgeDrag = createActiveEditorSelectionEdgeDrag({
      layout: options.selectionMoveLayout,
      navigation: this.#navigation,
      ownerWindow,
      workScheduler: this.#workScheduler,
      scrollOwner: () => this.#scrollOwner,
    });
    const interactions = Interactions.createActiveEditorInteractions({
      controller: options,
      dispatchMove: (pointer) => this.#dispatch({ type: "pointer-move", ...pointer }),
      history: this.#history,
      isAttached: () => this.#availability.attached,
      isEnabled: () => this.#availability.acceptsInput,
      lastSessionPointer: () => this.#cursor.lastPagePointer,
      navigation: this.#navigation,
      onPasteCommitted: () => this.#configureTool("select"),
      onPendingChanged: (pending) => this.#availability.setPending(pending),
      ownerWindow,
      selection: () => this.#selection,
      selectionFrames: this.#selectionFrames,
      setSelection: (selection) => this.#setSelection(selection),
      snapping: () => this.#snapping,
    });
    [this.#actions, this.#coalesced, this.#handles, this.#menus, this.#preparedHistory] = [
      interactions.actions,
      interactions.coalesced,
      interactions.handles,
      interactions.menus,
      interactions.preparedHistory,
    ];
    [this.#keyboard, this.#gestures] = this.#createInputControllers(options);
    this.#cursor = ToolCursor.createActiveToolCursorController(
      [options.container, this.#renderer],
      [() => this.#input, () => this.#styles.defaults],
      [this.#availability, this.#menus, this.#handles, this.#navigation],
      () => this.#scrollOwner.getBoundingClientRect(),
    );
    this.#pointer = this.#createPointerController(ownerWindow);
    createChromeCallbacks(
      [this.#actions, this.#background, this.#chromeState, this.#styles, options],
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
    this.#pendingSelection.cancel();
    this.#cursor.dispose();
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
    const handled = this.#availability.acceptsInput
      ? this.#keyboard.handleKeyDown(event)
      : this.#keyboard.handlePendingClipboardKeyDown(event);
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
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
    this.#navigation.cancelNavigation();
    if (ControllerTouch.isTouchInteraction(this.#input.interaction))
      this.#dispatch({ type: "reset" });
  }
  public readonly blocksNativeTouchScrolling = (): boolean =>
    this.#handles.activePointerType === "touch" ||
    ControllerTouch.touchInteractionBlocksNativeScroll(this.#input.interaction);
  public recoverInterruptedTouch(): void {
    this.preparePrimaryTouchStart();
    if (this.#input.consumedPointerIds.length > 0) this.#dispatch({ type: "reset" });
    this.#captures.releaseAll();
    this.#penGuard.stop();
  }
  public recoverTouchTerminal(pointerId: number): void {
    if (ControllerTouch.touchInteractionOwnsPointer(this.#input.interaction, pointerId))
      this.#pointer.cancelPointer(pointerId);
  }
  public handleToolbarAction(action: ToolbarAction, trigger?: HTMLButtonElement): void {
    if (Helpers.isClipboardAction(action)) return this.#actions.execute(action);
    if (!this.#availability.acceptsInput) return;
    if (Helpers.isTool(action)) {
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
    else if (action === "finger-drawing") {
      this.#input = this.#touchMode.toggle(this.#input);
      this.#onStateChanged();
    } else if (action === "delete" && this.#actions.isAvailable(action))
      this.#actions.execute(action);
  }
  readonly handleLostPointerCapture = (event: PointerEvent) =>
    this.#captures.runIfOwned(event.pointerId, () => this.#pointer.handleLostPointerCapture(event));
  public handleNativeScroll(): void {
    if (this.#availability.acceptsInput) this.#navigation.notifyScroll();
  }
  public handleWheel(event: WheelEvent): void {
    if (!this.#availability.acceptsInput) return;
    if (Interactions.hasStableGeometryGesture(this.#input, this.#handles)) {
      this.#navigation.cancelPanMomentum();
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (this.#navigation.updateWheel(event)) event.preventDefault();
  }
  public readonly handlePaste = (data: ClipboardData | null, surfaceOwned = false): boolean =>
    this.#keyboard.handlePaste(data, surfaceOwned);
  public readonly isActionAvailable = (action: ContextMenuAction): boolean =>
    this.#actions.isAvailable(action);
  public readonly executeAction = (action: ContextMenuAction): void =>
    this.#actions.execute(action);
  public setEnabled(enabled: boolean): void {
    if (!enabled) this.#actions.cancelPendingConfirmation();
    this.#availability.setEnabled(enabled);
    if (enabled) void this.#actions.refreshPasteAvailability();
  }
  public readonly setLayout = (layout: ToolbarLayoutStage): void =>
    this.#chromeState.setLayout(layout);
  public readonly setZoom = (zoom: number): void => this.#navigation.setZoom(zoom);
  public applyResize(update: ActiveEditorResizeUpdate): boolean {
    if (Interactions.hasStableGeometryGesture(this.#input, this.#handles))
      this.#cancelActiveGesture();
    return this.#navigation.applyResize(update);
  }
  public readonly getViewState = (): ActiveEditorViewState => this.#navigation.getViewState();
  public readonly readResizeAnchor = () => this.#navigation.readResizeAnchor();
  public recordMarkdownHistory(): void {
    if (this.#availability.acceptsInput) this.#keyboard.recordMarkdownHistory();
  }
  public readonly restoreViewState = (state: ActiveEditorViewState): boolean =>
    this.#navigation.restoreViewState(state);
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
    this.#keyboard.updateShortcuts(settings.keyboardShortcuts);
    this.#input = EditorInput.reduceInput(this.#input, {
      type: "configure",
      deviceFingerDrawingEnabled: settings.fingerDrawingEnabled,
    }).state;
    if (changed) this.#onStateChanged();
  }
  public updateSnappingSettings(settings: ActiveEditorControllerOptions["snapping"]): void {
    this.#snapping = structuredClone(settings);
  }
  public toolbarState(): ToolbarState {
    return Helpers.createToolbarState({
      actionConfirmation: this.#actions.actionConfirmation,
      activeTool: this.#input.activeTool,
      canRedo: this.#availability.acceptsInput && this.#history.canRedo,
      canUndo: this.#availability.acceptsInput && this.#history.canUndo,
      canPaste: this.#availability.acceptsInput && this.#actions.canPaste,
      fingerDrawingEnabled: this.#touchMode.enabled,
      fingerDrawingAvailable: this.#touchMode.available,
      hasSelection: this.#selection.size > 0,
      openFlyout: this.#chromeState.openFlyout,
      pasteVisible: this.#actions.pasteVisible,
      saveStatus: this.#model.getSaveStatus?.(),
    });
  }
  #beginPreview(start: GesturePreviewStart, options: ActiveEditorControllerOptions) {
    this.#pendingSelection.cancel();
    if (this.#chromeState.closeFlyout()) this.#menus.closeToolbar();
    const pageStart = { ...start, pointer: this.#navigation.pageSample(start.pointer) };
    return this.#coalesced.wrapProjected(
      createActiveEditorPreview(pageStart, {
        selectionSignal: this.#pendingSelection.signal,
        defaults: this.#styles.defaults,
        history: this.#history,
        model: this.#model,
        ownerWindow: this.#ownerWindow,
        workScheduler: this.#workScheduler,
        onFeedback: options.onFeedback,
        pageToScreen: (point) => this.#navigation.localPointFromPage(point),
        pageToViewport: (point) => this.#navigation.screenPoint(point),
        viewportToPage: ({ x, y }) => this.#navigation.pagePoint({ clientX: x, clientY: y }),
        preparedHistory: this.#preparedHistory,
        renderer: this.#renderer,
        sceneStore: this.#sceneStore,
        selection: () => this.#selection,
        selectionFrames: this.#selectionFrames,
        selectionEdgeDrag: this.#selectionEdgeDrag,
        setSelection: (selection) => this.#setSelection(selection),
        snapping: this.#snapping,
        snappingInverted: () => this.#snappingInversion?.inverted ?? false,
        zoom: () => this.#navigation.zoom,
      }),
      (sample) => ({ ...this.#navigation.pageSample(sample), time: sample.time }),
    );
  }
  #capturePointer(pointerId: number): void {
    this.#captures.capture(pointerId);
    const last = this.#cursor.lastPagePointer;
    if (last?.pointerId === pointerId) this.#penGuard.begin(last.pointerType, this.#scrollOwner);
  }
  #configureTool(tool: EditorInput.EditorTool): void {
    const changed = this.#input.activeTool !== tool;
    this.#input = configureInputTool(this.#input, tool);
    const closedFlyout = this.#chromeState.closeFlyout();
    if (closedFlyout) this.#menus.closeToolbar();
    if (changed && !closedFlyout) this.#onStateChanged();
  }
  #cancelActiveGesture(): boolean {
    this.#pendingSelection.cancel();
    this.#snappingInversion = undefined;
    if (this.#input.interaction !== undefined || this.#input.consumedPointerIds.length > 0) {
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
    this.#pendingSelection.cancel();
    this.#interruptLayoutForInput();
    this.#chromeState.closeFlyout();
    this.#menus.closeToolbar();
  }
  #createInputControllers(
    options: ActiveEditorControllerOptions,
  ): readonly [ActiveEditorKeyboardController, GestureController] {
    return createActiveEditorInputControllers({
      actions: this.#actions,
      availability: this.#availability,
      beginPreview: (start) => this.#beginPreview(start, options),
      cancelActiveGesture: () => this.#cancelActiveGesture(),
      capturePointer: (pointerId) => this.#capturePointer(pointerId),
      captures: this.#captures,
      chromeState: this.#chromeState,
      dispatch: (action) => this.#dispatch(action),
      hasStableGeometryGesture: () =>
        Interactions.hasStableGeometryGesture(this.#input, this.#handles),
      history: this.#history,
      keyboardShortcuts: options.deviceSettings.keyboardShortcuts,
      lastScreenPointer: () => this.#cursor.lastScreenPointer,
      longPress: this.#longPress,
      menus: this.#menus,
      model: this.#model,
      navigation: this.#navigation,
      onFeedback: options.onFeedback,
      onStateChanged: this.#onStateChanged,
      ownerWindow: this.#ownerWindow,
      selection: () => this.#selection,
      setSelection: (selection) => this.#setSelection(selection),
    });
  }
  #createPointerController(ownerWindow: Window): ActiveEditorPointerController {
    return new ActiveEditorPointerController({
      beginHandlePointer: (pointerType) => {
        this.#navigation.begin();
        this.#penGuard.begin(pointerType, this.#scrollOwner);
      },
      coalesced: this.#coalesced,
      cursor: this.#cursor,
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
      selectionFrames: this.#selectionFrames,
      setSnappingInverted: (pointerId, inverted) => {
        this.#snappingInversion = resolveSnappingPointerOverride(
          this.#snappingInversion,
          pointerId,
          inverted,
        );
      },
      setLastPointer: this.#cursor.recordSessionPointer,
    });
  }
  #dispatch(action: EditorInput.InputAction): void {
    if (action.type === "reset") this.#pendingSelection.cancel();
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
    this.#cursor?.refresh();
  }
  #setSelection(selection: ReadonlySet<string>): void {
    this.#pendingSelection.cancel();
    if (selection === this.#selection) return;
    if (!Helpers.sameSelectionMembers(selection, this.#selection)) this.#selectionFrames.reset();
    this.#selection = selection;
    this.#renderer.setSelectedElements(selection);
    this.#input = { ...this.#input, hasSelection: selection.size > 0 };
    this.#handles.renderSelection();
    this.#onStateChanged();
  }
}
