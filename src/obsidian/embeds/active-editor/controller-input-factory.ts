import type { GestureController, GestureControllerPorts } from "../../../editor/gestures/public";
import type { InputAction, PointerSample } from "../../../editor/input/index";
import type { LongPressAction } from "../../../editor/input/input-types";
import type { KeyboardShortcutSettingsV1 } from "../../../domain/settings/index";
import { selectElement } from "../../../editor/selection/public";

import type { ActiveEditorActions } from "./controller-actions";
import type { ActiveEditorAvailability } from "./controller-availability";
import type { ActiveEditorChromeState } from "./controller-chrome-state";
import { createActiveEditorGestureController } from "./controller-gesture-factory";
import type { ActiveEditorHistory } from "./history";
import { createActiveEditorKeyboardController } from "./controller-keyboard-factory";
import type { ActiveEditorKeyboardController } from "./controller-keyboard";
import type { ActiveEditorLongPressScheduler } from "./long-press";
import type { ActiveEditorMenuController } from "./controller-menu";
import type { ActiveEditorNavigation } from "./navigation";
import type { ActivePointerCaptureOwner } from "./pointer-capture";
import type { EditableDocumentModel } from "../vault-document-session";
import type { InkbookFeedbackCode } from "../../feedback";

interface ActiveEditorInputFactoryOptions {
  readonly actions: ActiveEditorActions;
  readonly availability: Pick<ActiveEditorAvailability, "setPending">;
  readonly beginPreview: GestureControllerPorts["beginPreview"];
  readonly cancelActiveGesture: () => boolean;
  readonly capturePointer: (pointerId: number) => void;
  readonly captures: Pick<ActivePointerCaptureOwner, "release">;
  readonly chromeState: Pick<ActiveEditorChromeState, "closeFlyout">;
  readonly dispatch: (action: InputAction) => void;
  readonly hasStableGeometryGesture: () => boolean;
  readonly history: ActiveEditorHistory;
  readonly keyboardShortcuts: KeyboardShortcutSettingsV1;
  readonly lastScreenPointer: () => PointerSample | null;
  readonly longPress: ActiveEditorLongPressScheduler;
  readonly longPressTarget: (pointerId: number) => LongPressAction["target"];
  readonly menus: ActiveEditorMenuController;
  readonly model: EditableDocumentModel;
  readonly navigation: ActiveEditorNavigation;
  readonly onFeedback: (code: InkbookFeedbackCode) => void;
  readonly onStateChanged: () => void;
  readonly ownerWindow: Window;
  readonly selection: () => ReadonlySet<string>;
  readonly setSelection: (selection: ReadonlySet<string>) => void;
}

export function createActiveEditorInputControllers(
  options: ActiveEditorInputFactoryOptions,
): readonly [ActiveEditorKeyboardController, GestureController] {
  const clearSelection = () => options.setSelection(new Set());
  const closeFlyout = () => {
    const closed = options.chromeState.closeFlyout();
    if (closed) options.menus.closeToolbar();
    return closed;
  };
  const selectAll = () =>
    options.setSelection(
      new Set([
        ...options.model.store.materializeBandOrder("highlight"),
        ...options.model.store.materializeBandOrder("content"),
      ]),
    );
  const keyboard = createActiveEditorKeyboardController(
    [
      options.actions,
      options.history,
      options.navigation,
      options.ownerWindow.document,
      options.onFeedback,
      (pending) => options.availability.setPending(pending),
    ],
    [options.lastScreenPointer, () => !options.hasStableGeometryGesture()],
    [clearSelection, selectAll, () => options.selection().size],
    [
      () => options.ownerWindow.document.activeElement,
      options.cancelActiveGesture,
      closeFlyout,
      (position) => options.dispatch({ type: "context-menu", source: "keyboard", ...position }),
    ],
    options.keyboardShortcuts,
  );
  const openContextMenu: GestureControllerPorts["openContextMenu"] = (source, position) =>
    options.menus.openFromSource(
      source,
      source === "keyboard" ? position : options.navigation.pagePointFromScreen(position),
    );
  const selectOne: GestureControllerPorts["selectElement"] = (elementId, mode) =>
    options.setSelection(selectElement(options.selection(), elementId, mode));
  const gestures = createActiveEditorGestureController(
    [openContextMenu, options.beginPreview],
    [
      (anchor) => options.navigation.beginPinchScreen(anchor),
      () => options.navigation.finish(),
      (delta) => options.navigation.pan(delta),
      (kind) => (kind === "page-pan" ? options.navigation.revert() : options.navigation.finish()),
      () => options.navigation.revert(),
      (anchor, factor) => options.navigation.updatePinchScreen(anchor, factor),
    ],
    [
      (pointerId) => options.longPress.cancel(pointerId),
      options.capturePointer,
      (pointerId) => options.captures.release(pointerId),
      (pointerId, delayMs) =>
        options.longPress.schedule(pointerId, delayMs, () => {
          const target = options.longPressTarget(pointerId);
          options.dispatch({
            type: "long-press",
            pointerId,
            ...(target === undefined ? {} : { target }),
          });
        }),
    ],
    [clearSelection, selectOne],
    [options.onStateChanged, options.onStateChanged],
  );
  return [keyboard, gestures];
}
