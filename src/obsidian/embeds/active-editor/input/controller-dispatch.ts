import type { GestureController } from "../../../../editor/gestures/public";
import {
  reduceInput,
  type EditorTool,
  type InputAction,
  type InputState,
} from "../../../../editor/input/index";
import type { BrowserScrollElement, PenScrollGuard } from "../../../scrolling/index";
import type { EditableDocumentModel } from "../../document-session/vault-document-session";

import type { ActiveEditorNavigation } from "../navigation/navigation";
import type { ActiveEditorHandleInteraction } from "../previews/handle-interaction";
import type { ActivePointerCaptureOwner } from "./pointer-capture";

export function cancelHandle(
  handles: ActiveEditorHandleInteraction,
  captures: ActivePointerCaptureOwner,
  navigation: ActiveEditorNavigation,
  penGuard: PenScrollGuard<BrowserScrollElement>,
): boolean {
  const pointerId = handles.activePointerId;
  if (pointerId === undefined || !handles.cancel(pointerId)) return false;
  captures.release(pointerId);
  navigation.finish();
  penGuard.stop();
  return true;
}

export function applyInputAction(
  input: InputState,
  action: InputAction,
  gestures: GestureController,
  model: EditableDocumentModel,
  penGuard: PenScrollGuard<BrowserScrollElement>,
  navigation: ActiveEditorNavigation,
): InputState {
  const wasActive = input.interaction !== undefined;
  const reduction = reduceInput(input, action);
  gestures.apply(reduction);
  if (action.type === "reset") navigation.cancelNavigation();
  const active = reduction.state.interaction !== undefined;
  if (active !== wasActive) model.setGestureActive(active);
  if (!active) {
    penGuard.stop();
    navigation.finish();
  }
  return reduction.state.zoom === navigation.zoom
    ? reduction.state
    : { ...reduction.state, zoom: navigation.zoom };
}

export function configureInputTool(input: InputState, tool: EditorTool): InputState {
  return reduceInput(input, { type: "configure", activeTool: tool }).state;
}
