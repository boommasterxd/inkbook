import { EditorView } from "@codemirror/view";

/** Floating table chrome reuses this editor's public configured style modules. */
export function mountTextControlStyles(
  view: EditorView,
  coordinates?: { readonly drawingDocument: Document },
): () => void {
  const drawingDocument = coordinates?.drawingDocument ?? view.dom.ownerDocument;
  if (drawingDocument === view.dom.ownerDocument) return () => undefined;
  const style = drawingDocument.createElement("style");
  style.setAttribute("data-inkbook-text-control-styles", "");
  style.textContent = view.state
    .facet(EditorView.styleModule)
    .map((module) => module.getRules())
    .join("\n");
  drawingDocument.head.append(style);
  return () => style.remove();
}
