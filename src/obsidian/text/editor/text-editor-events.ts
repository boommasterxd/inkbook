import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { TextSourceRange } from "../../../domain/text/text-types";

/** Browser replacements retain noneditable table DOM; replace their canonical source instead. */
export function replaceTextTableSelection(
  event: InputEvent,
  view: EditorView,
  hasTable: (range: TextSourceRange) => boolean,
): boolean {
  const { main } = view.state.selection;
  if (
    event.target !== view.contentDOM ||
    event.isComposing ||
    event.inputType !== "insertText" ||
    event.data === null ||
    main.empty ||
    !hasTable({ start: main.from, end: main.to })
  )
    return false;
  event.preventDefault();
  view.dispatch({ ...view.state.replaceSelection(event.data), userEvent: "input.type" });
  return true;
}

/** Native editing events never reach the canvas's command and gesture handlers. */
export function isolateTextEditorEvents(): Extension {
  const stop = (event: Event): boolean => {
    event.stopPropagation();
    return false;
  };
  return EditorView.domEventObservers({
    keydown: stop,
    pointerdown: stop,
    contextmenu: stop,
    paste: stop,
  });
}
