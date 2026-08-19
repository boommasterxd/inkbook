import type { EditorView } from "@codemirror/view";

export type EditorViewAccessResultV1 =
  | { readonly kind: "available"; readonly view: EditorView }
  | {
      readonly kind: "unavailable";
      readonly reason: "host-property-absent" | "host-property-malformed";
    };

export function accessEditorViewV1(editor: unknown): EditorViewAccessResultV1 {
  if (!isRecord(editor) || !("cm" in editor)) {
    return Object.freeze({
      kind: "unavailable",
      reason: "host-property-absent",
    });
  }
  const candidate: unknown = editor.cm;
  if (!isEditorViewShape(candidate)) {
    return Object.freeze({
      kind: "unavailable",
      reason: "host-property-malformed",
    });
  }
  return Object.freeze({ kind: "available", view: candidate });
}

function isEditorViewShape(value: unknown): value is EditorView {
  if (!isRecord(value)) return false;
  return (
    typeof value.dispatch === "function" &&
    typeof value.setState === "function" &&
    isRecord(value.state) &&
    typeof value.state.update === "function"
  );
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}
