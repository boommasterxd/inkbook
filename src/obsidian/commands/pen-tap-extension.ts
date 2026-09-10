import { type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
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
  const coords = { x: event.clientX, y: event.clientY };
  // The final empty line can lack a precise caret position in the host editor.
  const position = view.posAtCoords(coords) ?? view.posAtCoords(coords, false);
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

function isInsertionSurface(view: EditorView, event: PointerEvent): boolean {
  if (event.composedPath().includes(view.contentDOM)) return true;
  if (event.target !== view.scrollDOM) return false;
  const bounds = view.scrollDOM.getBoundingClientRect();
  const left = bounds.left + view.scrollDOM.clientLeft;
  const top = bounds.top + view.scrollDOM.clientTop;
  return (
    event.clientX >= left &&
    event.clientX < left + view.scrollDOM.clientWidth &&
    event.clientY >= top &&
    event.clientY < top + view.scrollDOM.clientHeight
  );
}

function consumeEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

export function createPenTapInsertionExtension(controller: PenTapInsertionController): Extension {
  return ViewPlugin.define((view) => {
    let pointerId: number | undefined;
    const pointerdown = (event: PointerEvent): void => {
      controller.cancel();
      pointerId = undefined;
      if (
        event.defaultPrevented ||
        event.pointerType !== "pen" ||
        event.button !== 0 ||
        event.buttons !== 1 ||
        isInsideInkbookWidget(event) ||
        !isInsertionSurface(view, event)
      )
        return;
      const target = targetAtEvent(view, event);
      if (target === undefined || !controller.begin(pointerSample(event), target)) return;
      pointerId = event.pointerId;
      consumeEvent(event);
    };
    const pointerup = (event: PointerEvent): void => {
      if (pointerId !== event.pointerId) return;
      pointerId = undefined;
      // Prevent host focus before the command changes the editor selection.
      consumeEvent(event);
      controller.complete(pointerSample(event));
    };
    const pointercancel = (event: PointerEvent): void => {
      if (pointerId !== event.pointerId) return;
      controller.cancel(pointerId);
      pointerId = undefined;
    };
    const click = (event: PointerEvent): void => {
      if (controller.consumeClick(pointerSample(event))) consumeEvent(event);
    };
    view.dom.addEventListener("pointerdown", pointerdown, true);
    view.dom.addEventListener("pointerup", pointerup, true);
    view.dom.addEventListener("pointercancel", pointercancel, true);
    view.dom.addEventListener("click", click, true);
    return {
      destroy: () => {
        if (pointerId !== undefined) controller.cancel(pointerId);
        view.dom.removeEventListener("pointerdown", pointerdown, true);
        view.dom.removeEventListener("pointerup", pointerup, true);
        view.dom.removeEventListener("pointercancel", pointercancel, true);
        view.dom.removeEventListener("click", click, true);
      },
    };
  });
}
