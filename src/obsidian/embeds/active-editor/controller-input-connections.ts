import { isClipboardAction, isTool } from "./controller-helpers";
import type { GestureController } from "../../../editor/gestures/public";
import type { ActiveEditorControllerOptions } from "./controller-types";
import { createActiveEditorInputControllers } from "./input/controller-input-factory";
import type { ActiveEditorKeyboardController } from "./input/controller-keyboard";
import type { BrowserScrollElement, PenScrollGuard } from "../../scrolling/index";
import { ActiveEditorPointerController } from "./input/controller-pointer";
import type { ActivePointerCaptureOwner } from "./input/pointer-capture";

type PointerOptions = ConstructorParameters<typeof ActiveEditorPointerController>[0];

/** Publish actual scene geometry to both cursor and native text input owners. */
export function publishSceneLayout(
  layout: import("./navigation/navigation-layout").NavigationCursorLayout,
  cursor: Pick<
    import("./input/tool-cursor-controller").ActiveToolCursorController,
    "adoptSceneLayout"
  >,
  text: Pick<import("./text-session").ActiveTextSession, "hostLayoutChanged">,
): void {
  cursor.adoptSceneLayout(layout);
  text.hostLayoutChanged(layout.containerBounds.height);
}

type ControllerPointerBindings = Omit<
  PointerOptions,
  | "beginHandlePointer"
  | "finishHandlePointer"
  | "setLastPointer"
  | "releasePointer"
  | "capturePointer"
> & {
  readonly captures: ActivePointerCaptureOwner;
  readonly penGuard: PenScrollGuard<BrowserScrollElement>;
  readonly scrollOwner: () => BrowserScrollElement;
};

type InputFactoryOptions = Parameters<typeof createActiveEditorInputControllers>[0];
export type ControllerInputBindings = Omit<
  InputFactoryOptions,
  "controller" | "capturePointer" | "lastScreenPointer"
> &
  Omit<ControllerPointerBindings, "cursor" | "isEnabled"> & {
    readonly cursor: () => ControllerPointerBindings["cursor"];
  };

export function createControllerInputControllers(
  options: ActiveEditorControllerOptions,
  bindings: ControllerInputBindings,
): readonly [ActiveEditorKeyboardController, GestureController] {
  return createActiveEditorInputControllers({
    ...bindings,
    controller: options,
    capturePointer: (id) => captureControllerPointer(bindings, id),
    lastScreenPointer: () => bindings.cursor().lastScreenPointer,
  });
}

/** Input controllers share one pointer-capture and native-scroll ownership boundary. */
export function createControllerPointerController(
  bindings: ControllerInputBindings,
): ActiveEditorPointerController {
  return new ActiveEditorPointerController({
    ...bindings,
    cursor: bindings.cursor(),
    isEnabled: () => bindings.availability.acceptsInput,
    capturePointer: (pointerId) => captureControllerPointer(bindings, pointerId),
    beginHandlePointer: (pointerType) => {
      bindings.navigation.begin();
      bindings.penGuard.begin(pointerType, bindings.scrollOwner());
    },
    finishHandlePointer: () => {
      bindings.navigation.finish();
      bindings.penGuard.stop();
    },
    releasePointer: (pointerId) => bindings.captures.release(pointerId),
    setLastPointer: bindings.cursor().recordSessionPointer,
  });
}

function captureControllerPointer(
  bindings: Pick<ControllerInputBindings, "captures" | "cursor" | "penGuard" | "scrollOwner">,
  pointerId: number,
): void {
  bindings.captures.capture(pointerId);
  const last = bindings.cursor().lastPagePointer;
  if (last?.pointerId === pointerId)
    bindings.penGuard.begin(last.pointerType, bindings.scrollOwner());
}

interface ControllerToolbarBindings {
  readonly text: Pick<import("./text-session").ActiveTextSession, "active" | "finish">;
  readonly actions: InputFactoryOptions["actions"];
  readonly availability: InputFactoryOptions["availability"];
  readonly chromeState: import("./controller-chrome-state").ActiveEditorChromeState;
  readonly menus: InputFactoryOptions["menus"];
  readonly historyTraversal: import("./history-traversal").ActiveEditorHistoryTraversal;
  readonly configureTool: (tool: import("../../../editor/input/index").EditorTool) => void;
  readonly toggleFingerDrawing: () => void;
  readonly onStateChanged: () => void;
  readonly onLock: () => void;
}

export function dispatchControllerToolbarAction(
  action: import("../../../rendering/ui/toolbar-types").ToolbarAction,
  trigger: HTMLButtonElement | undefined,
  bindings: ControllerToolbarBindings,
): void {
  if (
    action !== "style" &&
    deferActionForText(bindings.text, () =>
      dispatchControllerToolbarAction(action, trigger, bindings),
    )
  )
    return;
  if (isClipboardAction(action)) return bindings.actions.execute(action);
  if (!bindings.availability.acceptsInput) return;
  if (isTool(action)) {
    bindings.configureTool(bindings.chromeState.activateTool(action));
    return;
  }
  if (action === "undo") bindings.historyTraversal.undo();
  else if (action === "redo") bindings.historyTraversal.redo();
  else if (action === "lock") {
    bindings.menus.closeToolbar();
    bindings.onLock();
  } else if (action === "shape-picker" || action === "overflow" || action === "style")
    bindings.menus.toggleToolbar(action === "shape-picker" ? "shape" : action, trigger);
  else if (action === "finger-drawing") {
    bindings.toggleFingerDrawing();
    bindings.onStateChanged();
  } else if (action === "delete" && bindings.actions.isAvailable(action))
    bindings.actions.execute(action);
}

export function executeAction(
  action: import("../../menus/index").ContextMenuAction,
  text: ControllerToolbarBindings["text"],
  actions: InputFactoryOptions["actions"],
): void {
  if (
    action !== "copy" &&
    action !== "copy-embed" &&
    deferActionForText(text, () => {
      if (actions.isAvailable(action)) executeAction(action, text, actions);
    })
  )
    return;
  actions.execute(action);
}

/** Document mutations resume only after the native text owner has published and released its draft. */
function deferActionForText(text: ControllerToolbarBindings["text"], resume: () => void): boolean {
  if (!text.active) return false;
  void text.finish().then((finished) => {
    if (finished) resume();
  });
  return true;
}
