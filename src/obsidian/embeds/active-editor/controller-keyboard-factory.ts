import type { InputPoint } from "../../../editor/input/index";
import type { InkbookFeedbackCode } from "../../feedback";

import type { ActiveEditorActions } from "./controller-actions";
import { ActiveEditorKeyboardController } from "./controller-keyboard";
import type { ActiveEditorHistory } from "./history";
import type { ActiveEditorNavigation } from "./navigation";

type KeyboardCore = readonly [
  actions: ActiveEditorActions,
  history: ActiveEditorHistory,
  navigation: ActiveEditorNavigation,
  ownerDocument: Document,
  onFeedback: (code: InkbookFeedbackCode) => void,
  onPendingChanged: (pending: boolean) => void,
];

type KeyboardPointer = readonly [
  lastScreenPointer: () => InputPoint | null,
  navigationEnabled: () => boolean,
];

type KeyboardSelection = readonly [clear: () => void, selectAll: () => void, size: () => number];

type KeyboardSession = readonly [
  activeElement: () => Element | null,
  cancelGesture: () => boolean,
  closeFlyout: () => boolean,
  openKeyboardMenu: (position: InputPoint) => void,
];

export function createActiveEditorKeyboardController(
  [actions, history, navigation, ownerDocument, onFeedback, onPendingChanged]: KeyboardCore,
  [lastScreenPointer, navigationEnabled]: KeyboardPointer,
  [clearSelection, selectAll, selectionSize]: KeyboardSelection,
  [activeElement, cancelGesture, closeFlyout, openKeyboardMenu]: KeyboardSession,
): ActiveEditorKeyboardController {
  return new ActiveEditorKeyboardController({
    activeElement,
    actions,
    cancelGesture,
    clearSelection,
    closeFlyout,
    history,
    lastScreenPointer,
    navigation,
    navigationEnabled,
    onFeedback,
    onPendingChanged,
    openKeyboardMenu,
    ownerDocument,
    selectAll,
    selectionSize,
  });
}
