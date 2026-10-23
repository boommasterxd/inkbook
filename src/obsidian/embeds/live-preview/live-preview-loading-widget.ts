import { type EditorView, WidgetType } from "@codemirror/view";

import { documentRecognitionUnavailable } from "./live-preview-recognition-effects";
import { createLoadingPlaceholder } from "../preview/loading-placeholder";
import type { PresentationEntranceState } from "../presentation/presentation-entrance";
import type { EmbedIntegrationPorts } from "../presentation/presentation-port";

/** Owns only the neutral surface while recognition validates the document. */
export class InkbookLoadingPreviewWidget extends WidgetType {
  constructor(
    readonly documentId: string,
    readonly ports: EmbedIntegrationPorts,
    readonly entranceState: PresentationEntranceState,
  ) {
    super();
  }

  override eq(other: InkbookLoadingPreviewWidget): boolean {
    return (
      this.documentId === other.documentId &&
      this.ports === other.ports &&
      this.entranceState === other.entranceState
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const placeholder = createLoadingPlaceholder(view.dom, {
      motion: this.ports.sessions.getMotionPreference?.() ?? "system",
      subscribeMotionPreference: this.ports.subscribeMotionPreference,
      scheme: this.ports.scheme,
      workScheduler: this.ports.workScheduler(view.dom.ownerDocument.defaultView),
      ...(this.entranceState.initialHeight === undefined
        ? {}
        : { initialHeight: this.entranceState.initialHeight }),
      onHeight: (height) => {
        this.entranceState.initialHeight = height;
      },
      ...(this.entranceState.loadingStartedAt === undefined
        ? {}
        : { startedAt: this.entranceState.loadingStartedAt }),
    });
    const root = placeholder.element;
    this.entranceState.loadingStartedAt = placeholder.startedAt;
    root.remove();
    root.setAttribute("contenteditable", "false");
    let disposed = false;
    const release = this.ports.lifecycle.register(root, () => {
      disposed = true;
      placeholder.dispose();
      if (this.ports.documents.cached(this.documentId) === false)
        delete this.entranceState.loadingStartedAt;
    });
    if (release === undefined) {
      disposed = true;
      placeholder.dispose();
    }
    // Block replacements disappear from visibleRanges; start after editor construction
    // so its recognition subscriber can dispatch outside the active view update.
    queueMicrotask(() => {
      if (disposed) return;
      void this.ports.documents
        .recognize(this.documentId, view.dom.ownerDocument.defaultView)
        .then((result) => {
          if (
            disposed ||
            result !== false ||
            this.ports.documents.cached(this.documentId) !== undefined
          )
            return;
          view.dispatch({ effects: documentRecognitionUnavailable.of(this.documentId) });
        });
    });
    return root;
  }

  override destroy(dom: HTMLElement): void {
    this.ports.lifecycle.dispose(dom);
  }
}
