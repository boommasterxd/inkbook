import type { GestureController } from "../../../editor/gestures/public";
import {
  reduceInput,
  type EditorTool,
  type InputAction,
  type InputState,
} from "../../../editor/input/index";
import type { BrowserScrollElement, PenScrollGuard } from "../../scrolling/index";
import type { EditableDocumentModel } from "../vault-document-session";

import type { ActiveEditorNavigation } from "./navigation";

export function applyInputAction(
  input: InputState,
  action: InputAction,
  gestures: GestureController,
  model: EditableDocumentModel,
  penGuard: PenScrollGuard<BrowserScrollElement>,
  navigation: ActiveEditorNavigation,
): InputState {
  if (action.type === "reset") navigation.cancelNavigation();
  const wasActive = input.interaction !== undefined;
  const reduction = reduceInput(input, action);
  gestures.apply(reduction);
  const active = reduction.state.interaction !== undefined;
  if (active !== wasActive) model.setGestureActive(active);
  if (!active) {
    penGuard.stop();
    navigation.finish();
  }
  return reduction.state;
}

export function configureInputTool(input: InputState, tool: EditorTool): InputState {
  return reduceInput(input, { type: "configure", activeTool: tool }).state;
}
