import * as InputConnections from "./controller-input-connections";
import { createControllerTextBindings } from "./controller-text-bindings";
import type { NavigationCursorLayout as CursorLayout } from "./navigation/navigation-layout";
import type { GestureController, GesturePreviewStart } from "../../../editor/gestures/public";
import * as EditorInput from "../../../editor/input/index";
import { SelectionFrameSession } from "../../../editor/selection/public";
import type { ToolbarAction, ToolbarLayoutStage, ToolbarState } from "../../../rendering/ui/index";
import type { ContextMenuAction } from "../../menus/index";
import * as Scrolling from "../../scrolling/index";
import type { ActiveEditorActions } from "./controller-actions";
import type { ActiveEditorControllerOptions } from "./controller-types";
import type { CoalescedPointerInput } from "./input/coalesced-input";
import * as Chrome from "./controller-chrome";
import { applyInputAction, cancelHandle, configureInputTool } from "./input/controller-dispatch";
import type { ActiveEditorMenuController } from "./controller-menu";
import * as Interactions from "./controller-interactions";
import * as Helpers from "./controller-helpers";
import { createActiveEditorPreview } from "./previews/controller-previews";
import type { ActiveEditorHistory } from "./history";
import type { ActiveEditorHistoryTraversal } from "./history-traversal";
import type { ActiveEditorHandleInteraction } from "./previews/handle-interaction";
import { ActiveEditorNavigation, type ActiveEditorViewState } from "./navigation/navigation";
import type { ActiveEditorBackgroundSession } from "./background-session";
import { ActiveEditorLongPressScheduler } from "./input/long-press";
import type { PreparedElementHistory } from "./prepared-element-history";
import type { ActiveEditorResizeUpdate } from "./layout/layout";
import type { SynchronousClipboardData as ClipboardData } from "./clipboard-reader";
import type { ActiveEditorKeyboardController } from "./input/controller-keyboard";
import { ActiveEditorPointerController } from "./input/controller-pointer";
import * as ControllerTouch from "./input/controller-touch";
import { ActiveEditorTouchMode, createActiveEditorTouchMode } from "./input/controller-touch-mode";
import { createActiveEditorSelectionEdgeDrag } from "./previews/controller-selection-edge";
import { ActiveEditorAvailability } from "./controller-availability";
import { ActiveEditorChromeState } from "./controller-chrome-state";
import { ActivePointerCaptureOwner } from "./input/pointer-capture";
import { resolveSnappingPointerOverride } from "./previews/snapping-settings";
import * as ToolCursor from "./input/tool-cursor-controller";
import { PendingSelection } from "./previews/pending-selection";
import { textPastePoint } from "./controller-text";
export class ActiveEditorController {
  readonly #textBindings: ReturnType<typeof createControllerTextBindings>;
  readonly #onboarding: ReturnType<typeof Chrome.createActiveEditorChrome>;
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
  #holdToShape: ActiveEditorControllerOptions["holdToShape"];
  #snappingInversion: { readonly inverted: boolean; readonly pointerId: number } | undefined;
  #scrollOwner: Scrolling.BrowserScrollElement;
  readonly #toolbarAction = this.handleToolbarAction.bind(this);
  readonly #selectionEdgeDrag: ReturnType<typeof createActiveEditorSelectionEdgeDrag>;
  readonly #selectionFrames = new SelectionFrameSession(() => this.#handles.renderSelection());
  readonly #navigation: ActiveEditorNavigation;
  #selection: ReadonlySet<string> = new Set();
  readonly #touchMode: ActiveEditorTouchMode;
  #leftHanded: boolean;
  readonly #resetForDisable = (): void => {
    this.#keyboard?.cancelSelection();
    this.#preparedHistory?.cancel();
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
    this.#onStateChanged = () =>
      Chrome.refreshActiveEditorChrome([this.#cursor, this.#menus], options.onStateChanged);
    this.#chromeState = new ActiveEditorChromeState(this.#onStateChanged);
    const ownerWindow = Helpers.activeEditorWindow(options.container);
    this.#ownerWindow = ownerWindow;
    this.#longPress = new ActiveEditorLongPressScheduler(ownerWindow);
    [this.#renderIcon, this.#workScheduler] = [options.renderIcon, options.workScheduler];
    [this.#renderer, this.#sceneStore] = [options.renderer, options.sceneStore];
    this.#captures = new ActivePointerCaptureOwner(options.renderer.inputSurface);
    [this.#scrollOwner, this.#snapping] = [options.scrollOwner, structuredClone(options.snapping)];
    this.#holdToShape = structuredClone(options.holdToShape);
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
    this.#touchMode = createActiveEditorTouchMode(options);
    this.#leftHanded = options.deviceSettings.leftHandedToolbar;
    this.#input = Interactions.createControllerInputState(options);
    if (Helpers.isShapeTool(options.startupTool))
      this.#chromeState.selectShape(options.startupTool);
    this.#penGuard = Interactions.createControllerPenGuard(this.#workScheduler);
    this.#navigation = Interactions.createControllerNavigation({
      controller: options,
      getInput: () => this.#input,
      onCancelPinch: () => this.#cancelActiveGesture(),
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
    const interactions = this.#createInteractions(options);
    [this.#actions, this.#coalesced, this.#handles, this.#menus, this.#preparedHistory] = [
      interactions.actions,
      interactions.coalesced,
      interactions.handles,
      interactions.menus,
      interactions.preparedHistory,
    ];
    this.#textBindings = createControllerTextBindings(options, {
      handles: this.#handles,
      captures: this.#captures,
      pointer: () => this.#pointer,
      menus: this.#menus,
      navigation: this.#navigation,
      selection: () => this.#selection,
      setSelection: (selection) => this.#setSelection(selection),
      selectionFrames: this.#selectionFrames,
      preparedHistory: this.#preparedHistory,
      isEnabled: () => this.#availability.acceptsInput,
      onStateChanged: this.#onStateChanged,
      onSelectionGeometryChanged: () => this.#handles.renderSelection(),
      onFinished: () => this.#configureTool("select"),
    });
    const inputBindings = this.#inputBindings(options);
    [this.#keyboard, this.#gestures] = InputConnections.createControllerInputControllers(
      options,
      inputBindings,
    );
    this.#cursor = ToolCursor.createActiveToolCursorController(
      [options.container, this.#renderer],
      [() => this.#input, () => this.#textBindings.styles.defaults],
      [this.#availability, this.#menus, this.#handles, this.#navigation],
      () => this.#scrollOwner.getBoundingClientRect(),
    );
    this.#pointer = InputConnections.createControllerPointerController(inputBindings);
    this.#onboarding = Chrome.createActiveEditorChrome(
      [this.#actions, this.#background, this.#chromeState, this.#textBindings.styles, options],
      [() => this.#input.activeTool, (tool) => this.#configureTool(tool)],
      [this.#menus, this.#model, () => this.#selection.size, this.#renderIcon],
      () => this.#scrollOwner,
    );
  }
  public readonly chromeProps = () =>
    Chrome.createActiveEditorChromeProps({
      state: [this.#chromeState, this.#textBindings.styles],
      activeTool: this.#input.activeTool,
      leftHanded: this.#leftHanded,
      onToolbarAction: this.#toolbarAction,
      ownerDocument: this.#ownerWindow.document,
      renderIcon: this.#renderIcon,
      toolbarState: this.#onboarding.withTourPreview(this.toolbarState()),
      onboarding: this.#onboarding.invitation,
    });
  public dispose(): void {
    this.#textBindings.releaseInput();
    this.#textBindings.session.dispose();
    this.#pointer.dispose();
    this.#onboarding.dispose();
    this.#pendingSelection.cancel();
    this.#cursor.dispose();
    this.#textBindings.styles.dispose();
    this.#availability.setEnabled(false);
    this.#actions.dispose();
    this.#longPress.dispose();
    this.#menus.dispose();
    this.#keyboard.dispose();
    this.#handles.dispose();
    this.#preparedHistory.dispose();
    this.#historyTraversal.dispose();
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
  public readonly handlePointerBoundary = (pointerOver: boolean): void =>
    this.#keyboard.setPointerOver(pointerOver);
  readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.#textBindings.pointerDown(event)) this.#pointer.handlePointerDown(event);
  };
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
    if (ControllerTouch.touchTerminalNeedsRecovery(this.#input, pointerId))
      this.#pointer.cancelPointer(pointerId);
  }
  public handleToolbarAction(action: ToolbarAction, trigger?: HTMLButtonElement): void {
    InputConnections.dispatchControllerToolbarAction(action, trigger, {
      text: this.#textBindings.session,
      actions: this.#actions,
      availability: this.#availability,
      chromeState: this.#chromeState,
      menus: this.#menus,
      historyTraversal: this.#historyTraversal,
      configureTool: (tool) => this.#configureTool(tool),
      toggleFingerDrawing: () => {
        this.#input = this.#touchMode.toggle(this.#input);
      },
      onStateChanged: this.#onStateChanged,
      onLock: this.#onLock,
    });
  }
  readonly handleLostPointerCapture = (event: PointerEvent) =>
    this.#captures.runIfOwned(event.pointerId, () => this.#pointer.handleLostPointerCapture(event));
  public handleNativeScroll(): void {
    if (this.#availability.acceptsInput) this.#navigation.notifyScroll();
  }
  public adoptSceneLayout = (layout: CursorLayout): void =>
    InputConnections.publishSceneLayout(layout, this.#cursor, this.#textBindings.session);
  public handleWheel(event: WheelEvent): void {
    if (!this.#availability.acceptsInput) return;
    if (Interactions.hasStableGeometryGesture(this.#input, this.#handles)) {
      this.#navigation.cancelPanMomentum();
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (this.#navigation.updateWheel(event, this.#keyboard.hasWheelModifier(event)))
      event.preventDefault();
  }
  public readonly handlePaste = (data: ClipboardData | null, surfaceOwned = false): boolean =>
    this.#keyboard.handlePaste(data, surfaceOwned);
  public readonly isActionAvailable = (action: ContextMenuAction): boolean =>
    this.#actions.isAvailable(action);
  public readonly executeAction = (action: ContextMenuAction): void =>
    InputConnections.executeAction(action, this.#textBindings.session, this.#actions);
  public setEnabled(enabled: boolean): void {
    this.#onboarding.setEnabled(enabled);
    if (!enabled) this.#actions.cancelPendingConfirmation();
    this.#availability.setEnabled(enabled);
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
  public readonly readResizeAnchor: ActiveEditorNavigation["readResizeAnchor"] = (box) =>
    this.#navigation.readResizeAnchor(box);
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
    this.#onboarding.updateDismissed(settings.onboardingDismissed);
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
  public updateHoldToShapeSettings(settings: ActiveEditorControllerOptions["holdToShape"]): void {
    this.#holdToShape = structuredClone(settings);
  }
  public readonly toolbarState = (): ToolbarState =>
    Chrome.createActiveEditorToolbarState(
      [this.#actions, this.#availability, this.#history],
      [this.#touchMode, this.#chromeState],
      [this.#input.activeTool, this.#selection.size > 0],
    );
  #beginPreview(start: GesturePreviewStart, options: ActiveEditorControllerOptions) {
    this.#pendingSelection.cancel();
    if (this.#chromeState.closeFlyout()) this.#menus.closeToolbar();
    const pageStart = { ...start, pointer: this.#navigation.pageSample(start.pointer) };
    return this.#coalesced.wrapProjected(
      createActiveEditorPreview(pageStart, {
        createText: (box) => {
          void this.#textBindings.session.create(box);
        },
        selectionSignal: this.#pendingSelection.signal,
        selectionGeometry: () => this.#handles.selectionGeometry(),
        defaults: this.#textBindings.styles.defaults,
        ...(this.#holdToShape === undefined ? {} : { holdToShape: this.#holdToShape }),
        screenStart: start.pointer,
        isCurrent: () => this.#availability.attached,
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
    return cancelHandle(this.#handles, this.#captures, this.#navigation, this.#penGuard);
  }
  #interruptForInput(): void {
    this.#pendingSelection.cancel();
    this.#interruptLayoutForInput();
    this.#chromeState.closeFlyout();
    this.#menus.closeToolbar();
  }
  #createInteractions(options: ActiveEditorControllerOptions) {
    return Interactions.createActiveEditorInteractions({
      onHandleSettled: () => this.#textBindings?.handleInput.settled(),
      registerApplied: (...args) =>
        this.#textBindings?.session.registerProvisionalGeometryHistory(...args),
      reflowText: (...args) => this.#textBindings.session.reflow(...args),
      onPasteText: (source, invocation) =>
        this.#textBindings.session.create(
          { ...textPastePoint(invocation), width: 400 },
          source,
          false,
        ),
      controller: options,
      dispatchMove: (pointer) => this.#dispatch(this.#coalesced.moveAction(pointer, this.#input)),
      history: this.#history,
      isAttached: () => this.#availability.attached,
      isEnabled: () => this.#availability.acceptsInput,
      lastSessionPointer: () => this.#cursor.lastPagePointer,
      navigation: this.#navigation,
      onPasteCommitted: () => this.#configureTool("select"),
      onPendingChanged: (pending) => this.#availability.setPending(pending),
      ownerWindow: this.#ownerWindow,
      selection: () => this.#selection,
      selectionFrames: this.#selectionFrames,
      setSelection: (selection) => this.#setSelection(selection),
      snapping: () => this.#snapping,
    });
  }
  #inputBindings(options: ActiveEditorControllerOptions): InputConnections.ControllerInputBindings {
    return {
      activateElement: this.#textBindings.activateElement,
      geometry: [this.#handles, this.#selectionFrames, this.#preparedHistory],
      actions: this.#actions,
      availability: this.#availability,
      beginPreview: (start) => this.#beginPreview(start, options),
      cancelActiveGesture: () => this.#cancelActiveGesture(),
      captures: this.#captures,
      chromeState: this.#chromeState,
      dispatch: (action) => this.#dispatch(action),
      hasStableGeometryGesture: () =>
        Interactions.hasStableGeometryGesture(this.#input, this.#handles),
      history: this.#history,
      longPress: this.#longPress,
      longPressTarget: (pointerId) => this.#pointer.longPressTarget(pointerId),
      menus: this.#menus,
      model: this.#model,
      navigation: this.#navigation,
      onStateChanged: this.#onStateChanged,
      selection: () => this.#selection,
      setSelection: (selection) => this.#setSelection(selection),
      penGuard: this.#penGuard,
      scrollOwner: () => this.#scrollOwner,
      coalesced: this.#coalesced,
      cursor: () => this.#cursor,
      getInput: () => this.#input,
      handles: this.#handles,
      interruptForInput: () => this.#interruptForInput(),
      ownerWindow: this.#ownerWindow,
      renderer: this.#renderer,
      sceneStore: this.#sceneStore,
      selectionFrames: this.#selectionFrames,
      setSnappingInverted: (pointerId, inverted) => {
        this.#snappingInversion = resolveSnappingPointerOverride(
          this.#snappingInversion,
          pointerId,
          inverted,
        );
      },
    };
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
    this.#keyboard?.cancelSelection();
    this.#preparedHistory.cancel();
    if (!Helpers.sameSelectionMembers(selection, this.#selection)) this.#selectionFrames.reset();
    this.#selection = selection;
    this.#textBindings.styles.invalidateSelection();
    this.#renderer.setSelectedElements(selection);
    this.#input = { ...this.#input, hasSelection: selection.size > 0 };
    this.#handles.renderSelection();
    this.#onStateChanged();
  }
}
