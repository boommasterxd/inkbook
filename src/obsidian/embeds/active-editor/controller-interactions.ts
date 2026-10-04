import type { NavigationCursorLayout } from "./navigation-layout";
import { activeSceneViewportFromBounds } from "../active-scene-viewport";
import * as Scrolling from "../../scrolling/index";
import { createInputState, type InputState } from "../../../editor/input/index";
import type { PointerSample } from "../../../editor/input/index";
import { derivePageExtent } from "../../../domain/geometry/public";

import { CoalescedPointerInput } from "./coalesced-input";
import { ActiveEditorActions } from "./controller-actions";
import type { ActiveEditorControllerOptions } from "./controller-types";
import { ActiveEditorHandleInteraction } from "./handle-interaction";
import type { ActiveEditorHistory } from "./history";
import { ActiveEditorMenuController } from "./controller-menu";
import { ActiveEditorNavigation, type ActiveEditorNavigationOptions } from "./navigation";
import { PreparedElementHistory } from "./prepared-element-history";
import { visibleSelectionCenter } from "./controller-elements";
import type { ActiveEditorChromeState } from "./controller-chrome-state";
import type { ActivePointerCaptureOwner } from "./pointer-capture";
import type { GestureController } from "../../../editor/gestures/public";
import type { SelectionFrameSession } from "../../../editor/selection/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { ActiveEditorBackgroundSession } from "./background-session";
import { ActiveEditorHistoryTraversal } from "./history-traversal";

export interface ActiveEditorInteractionsOptions {
  readonly controller: ActiveEditorControllerOptions;
  readonly dispatchMove: (pointer: PointerSample) => void;
  readonly history: ActiveEditorHistory;
  readonly isAttached: () => boolean;
  readonly isEnabled: () => boolean;
  readonly navigation: ActiveEditorNavigation;
  readonly lastSessionPointer: () => PointerSample | null;
  readonly onPasteCommitted: () => void;
  readonly ownerWindow: Window;
  readonly onPendingChanged: (pending: boolean) => void;
  readonly selection: () => ReadonlySet<string>;
  readonly selectionFrames: SelectionFrameSession;
  readonly setSelection: (selection: ReadonlySet<string>) => void;
  readonly snapping: () => ActiveEditorControllerOptions["snapping"];
}

export function createControllerHistorySessions(options: {
  readonly controller: ActiveEditorControllerOptions;
  readonly history: ActiveEditorHistory;
  readonly onPendingChanged: (pending: boolean) => void;
}): readonly [ActiveEditorBackgroundSession, ActiveEditorHistoryTraversal] {
  const controller = options.controller;
  return [
    new ActiveEditorBackgroundSession({
      backgroundSpacing: controller.backgroundSpacing,
      history: options.history,
      model: controller.model,
      onPageChanged: controller.onPageChanged,
      onPagePreviewFinish: controller.onPagePreviewFinish,
      onPagePreview: controller.onPagePreview,
      onStateChanged: controller.onStateChanged,
    }),
    new ActiveEditorHistoryTraversal({
      history: options.history,
      onPendingChanged: options.onPendingChanged,
      onStateChanged: controller.onStateChanged,
    }),
  ];
}

export function createActiveEditorInteractions(options: ActiveEditorInteractionsOptions) {
  const controller = options.controller;
  const preparedHistory = new PreparedElementHistory({
    history: options.history,
    isAttached: options.isAttached,
    model: controller.model,
    motion: controller.renderer,
    onPendingChanged: options.onPendingChanged,
    workScheduler: controller.workScheduler,
  });
  const actions = new ActiveEditorActions({
    confirmEraseAll: controller.confirmEraseAll,
    currentSelection: options.selection,
    history: options.history,
    isAttached: options.isAttached,
    isEnabled: options.isEnabled,
    model: controller.model,
    onCopyEmbed: controller.onCopyEmbed,
    onDeleteEmbed: controller.onDeleteEmbed,
    onFeedback: controller.onFeedback,
    onPasteCommitted: options.onPasteCommitted,
    onPendingChanged: options.onPendingChanged,
    onStateChanged: controller.onStateChanged,
    ownerWindow: options.ownerWindow,
    renderer: controller.renderer,
    sceneStore: controller.sceneStore,
    setSelection: options.setSelection,
    lastSessionPointer: options.lastSessionPointer,
    visibleCenter: () => options.navigation.visibleCenter(),
  });
  return {
    actions,
    coalesced: new CoalescedPointerInput({
      dispatchMove: options.dispatchMove,
      frameScheduler: controller.workScheduler,
      now: () => controller.workScheduler.now(),
      project: (event) => options.navigation.screenPointer(event),
    }),
    handles: new ActiveEditorHandleInteraction({
      frameScheduler: controller.workScheduler,
      history: options.history,
      layout: controller.selectionMoveLayout,
      model: controller.model,
      pageToScreen: (point) => options.navigation.localPointFromPage(point),
      preparedHistory,
      renderer: controller.renderer,
      sceneStore: controller.sceneStore,
      selectionFrames: options.selectionFrames,
      selection: options.selection,
      snapping: options.snapping,
      zoom: () => options.navigation.zoom,
    }),
    menus: new ActiveEditorMenuController({
      workScheduler: controller.workScheduler,
      actions,
      factory: controller.menuFactory,
      inputSurface: controller.renderer.inputSurface,
      ...(controller.keymap === undefined ? {} : { keymap: controller.keymap }),
      ...(controller.createPhoneSheetHost === undefined
        ? {}
        : { createPhoneSheetHost: controller.createPhoneSheetHost }),
      ownerDocument: controller.container.ownerDocument,
      selectionSize: () => options.selection().size,
      storeSize: () => controller.model.store.size,
      toScreenPoint: (point) => options.navigation.screenPoint(point),
      visibleSelectionCenter: () =>
        visibleSelectionCenter(controller.sceneStore, options.selection()),
    }),
    preparedHistory,
  };
}

export function createControllerNavigation(options: {
  readonly controller: ActiveEditorControllerOptions;
  readonly getInput: ActiveEditorNavigationOptions["getInput"];
  readonly isSelectionMoveActive: () => boolean;
  readonly renderSelection: () => void;
  readonly adoptCursorLayout?: (layout: NavigationCursorLayout) => void;
  readonly scrollOwner: ActiveEditorNavigationOptions["scrollOwner"];
  readonly setInput: ActiveEditorNavigationOptions["setInput"];
}): ActiveEditorNavigation {
  const controller = options.controller;
  let appliedZoom = options.getInput().zoom;
  return new ActiveEditorNavigation({
    workScheduler: controller.workScheduler,
    onNavigationActive: (active) => controller.model.setNavigationActive?.(active),
    activePageHeight: () =>
      controller.selectionMoveLayout.currentHeight?.() ??
      derivePageExtent(controller.model.page, controller.model.store.getMaximumBottom() ?? null)
        .activeHeight,
    applyCamera: (camera, layout) => {
      if (layout !== undefined) {
        options.adoptCursorLayout?.(layout);
        controller.renderer.setViewport(
          activeSceneViewportFromBounds(layout.containerBounds, layout.ownerViewport),
        );
      }
      controller.renderer.setCamera(camera);
      if (camera.zoom !== appliedZoom || !options.isSelectionMoveActive()) {
        options.renderSelection();
      }
      appliedZoom = camera.zoom;
      controller.renderer.flushPointerFeedbackFrame(undefined, true);
    },
    applyZoomLayout: controller.applyZoomLayout,
    container: controller.container,
    getInput: options.getInput,
    renderer: controller.renderer,
    scrollOwner: options.scrollOwner,
    setInput: options.setInput,
  });
}

export function resetActiveEditorForDisable(
  [chrome, menus, handles, captures, gestures]: readonly [
    ActiveEditorChromeState,
    ActiveEditorMenuController,
    ActiveEditorHandleInteraction,
    ActivePointerCaptureOwner,
    GestureController,
  ],
  [model, navigation, penGuard]: readonly [
    { setGestureActive(active: boolean): void },
    ActiveEditorNavigation,
    { stop(): void },
  ],
  [dispatchReset, releasePointer]: readonly [() => void, (pointerId: number) => void],
): void {
  if (chrome.closeFlyout()) menus.closeToolbar();
  dispatchReset();
  const handlePointerId = handles.activePointerId;
  if (handlePointerId !== undefined && handles.cancel(handlePointerId)) {
    releasePointer(handlePointerId);
    navigation.finish();
  }
  captures.releaseAll();
  gestures.cancelActivePreview();
  model.setGestureActive(false);
  penGuard.stop();
}

export function createControllerInputState(options: ActiveEditorControllerOptions) {
  return createInputState({
    activeTool: options.startupTool,
    deviceFingerDrawingEnabled: options.deviceSettings.fingerDrawingEnabled,
  });
}

export function createControllerPenGuard(workScheduler: WorkScheduler) {
  return new Scrolling.PenScrollGuard({
    listeners: Scrolling.browserScrollListeners,
    metrics: Scrolling.browserScrollMetrics,
    scheduler: Scrolling.createAnimationFrameScheduler(workScheduler),
  });
}

export function hasStableGeometryGesture(
  input: InputState,
  handles: ActiveEditorHandleInteraction,
): boolean {
  return (
    handles.activePointerId !== undefined ||
    input.interaction?.phase === "lasso" ||
    input.interaction?.phase === "eraser-gesture"
  );
}
