import type { EditorView } from "@codemirror/view";

interface TextFocusPort {
  focusAt(position?: number | { readonly x: number; readonly y: number }): boolean;
  focus(): boolean;
}

export function focusTextEditorAt(
  view: EditorView,
  tables: TextFocusPort,
  position: number | { readonly x: number; readonly y: number } | undefined,
  reveal: boolean,
): void {
  if (tables.focusAt(position)) return;
  const at =
    typeof position === "number" ? position : position ? view.posAtCoords(position) : undefined;
  if (at !== undefined && at !== null)
    view.dispatch({
      selection: { anchor: Math.max(0, Math.min(view.state.doc.length, at)) },
      scrollIntoView: reveal,
    });
  focusTextEditorSelection(view, tables);
}

export function focusTextEditorSelection(view: EditorView, tables: TextFocusPort): void {
  if (!tables.focus()) view.focus();
}
