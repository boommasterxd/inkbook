import type { EditorView } from "@codemirror/view";
import { vi } from "vitest";

export interface TextTableMeasurement {
  readonly key?: unknown;
  readonly read: (view: EditorView) => unknown;
  readonly write?: (value: unknown, view: EditorView) => void;
}

/** A fixed host clip isolates native row windowing from simulated browser layout. */
export function mountTextTableViewport(): HTMLElement {
  const clip = document.createElement("div");
  clip.className = "inkbook-text-editor-viewport";
  const container = document.createElement("div");
  clip.append(container);
  document.body.append(clip);
  vi.spyOn(clip, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 100));
  return container;
}

/** Tests explicitly drive the owning view's public measurement read/write boundary. */
export function captureTextTableMeasurements(view: EditorView) {
  const pending: TextTableMeasurement[] = [];
  vi.spyOn(view, "requestMeasure").mockImplementation((request) => {
    if (request) pending.push(request);
  });
  const widget = view.contentDOM.querySelector<HTMLElement>(".inkbook-text-table-widget");
  if (!widget) throw new Error("Expected a mounted table preview.");
  return { pending, widget };
}
