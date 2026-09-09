import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";

import type { PenTapPointerSample, PenTapTarget } from "./pen-tap-insertion";
import { PenTapInsertionController } from "./pen-tap-insertion";
import { eventPathHasClass } from "./event-path";

function pointerSample(event: PointerEvent): PenTapPointerSample {
  return {
    button: event.button,
    buttons: event.buttons,
    clientX: event.clientX,
    clientY: event.clientY,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    timeStamp: event.timeStamp,
  };
}

function isInsideInkbookWidget(event: PointerEvent): boolean {
  return eventPathHasClass(event, "inkbook-root");
}

function targetAtEvent(view: EditorView, event: PointerEvent): PenTapTarget | undefined {
  const info = view.state.field(editorInfoField, false);
  const editor = info?.editor;
  const sourcePath = info?.file?.path;
  const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (info === undefined || editor === undefined || sourcePath === undefined || position === null)
    return undefined;
  return {
    context: info,
    editor,
    insideInkWidget: isInsideInkbookWidget(event),
    line: view.state.doc.lineAt(position).number - 1,
    sourcePath,
  };
}

export function createPenTapInsertionExtension(controller: PenTapInsertionController): Extension {
  return EditorView.domEventHandlers({
    pointercancel: (event) => {
      controller.cancel(event.pointerId);
      return false;
    },
    pointerdown: (event, view) => {
      const target = targetAtEvent(view, event);
      return target === undefined ? false : controller.begin(pointerSample(event), target);
    },
    pointerup: (event) => controller.complete(pointerSample(event)),
  });
}
