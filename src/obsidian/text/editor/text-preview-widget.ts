import { WidgetType, type EditorView } from "@codemirror/view";

export const TEXT_PREVIEW_VIEWPORT_EVENT = "inkbook-text-preview-viewport";

export function activateTextPreview(view: EditorView, position: number): void {
  view.dispatch({ selection: { anchor: position } });
  view.focus();
}

/** Preview work and event ownership end with the CodeMirror widget's DOM lifetime. */
export abstract class TextPreviewWidget extends WidgetType {
  readonly #renders = new WeakMap<HTMLElement, AbortController>();

  protected renderSignal(node: HTMLElement): AbortSignal {
    const abort = new AbortController();
    this.#renders.set(node, abort);
    return abort.signal;
  }

  public override ignoreEvent(): boolean {
    return true;
  }

  public override destroy(dom: HTMLElement): void {
    this.#renders.get(dom)?.abort();
    this.#renders.delete(dom);
  }
}
