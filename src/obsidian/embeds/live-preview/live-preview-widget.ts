import { type EditorView, WidgetType } from "@codemirror/view";

import type { InkbookDocumentRecognition } from "../preview/document-recognition";
import { createInkbookLockedPreview } from "../preview/locked-preview";
import { removeLivePreviewMarkdown } from "./live-preview-removal";
import { LivePreviewWidgetHeight } from "./live-preview-widget-height";
import { LivePreviewZoomScrollBinding } from "./live-preview-zoom-scroll";
import { PresentationController } from "../presentation/presentation-controller";
import type { EmbedIntegrationPorts } from "../presentation/presentation-port";
import { samePreviewContentIdentity } from "../preview/safe-preview-svg";
import type { PresentationEntranceState } from "../presentation/presentation-entrance";
import type { ResolvedInkbookDocument } from "../presentation/presentation-port";

export interface VisibleEmbed {
  readonly from: number;
  readonly resolved: ResolvedInkbookDocument;
  readonly sourcePath: string;
  readonly to: number;
}

let nextLivePreviewAttachmentId = 0;
const mountedControllers = new WeakMap<
  HTMLElement,
  { readonly controller: PresentationController; readonly widget: InkbookLivePreviewWidget }
>();

interface RecognizedVisibleEmbed extends VisibleEmbed {
  readonly preview: Exclude<InkbookDocumentRecognition, false>;
}

export class InkbookLivePreviewWidget extends WidgetType {
  readonly #embed: RecognizedVisibleEmbed;
  readonly #ports: EmbedIntegrationPorts;
  readonly #entranceState: PresentationEntranceState | undefined;
  #height: LivePreviewWidgetHeight | undefined;

  constructor(
    embed: RecognizedVisibleEmbed,
    ports: EmbedIntegrationPorts,
    entranceState?: PresentationEntranceState,
  ) {
    super();
    this.#embed = embed;
    this.#ports = ports;
    this.#entranceState = entranceState;
  }

  override get estimatedHeight(): number {
    return this.#height?.value ?? -1;
  }

  retainHeightFrom(previous: InkbookLivePreviewWidget): void {
    if (previous.#height !== undefined && this.#sameAttachment(previous)) {
      this.#height = previous.#height;
    }
  }

  override eq(other: InkbookLivePreviewWidget): boolean {
    return (
      this.#sameAttachment(other) &&
      samePreviewContentIdentity(
        this.#embed.preview.contentIdentity,
        other.#embed.preview.contentIdentity,
      )
    );
  }

  #sameAttachment(other: InkbookLivePreviewWidget): boolean {
    return (
      this.#ports === other.#ports &&
      this.#entranceState === other.#entranceState &&
      this.#embed.from === other.#embed.from &&
      this.#embed.to === other.#embed.to &&
      this.#embed.sourcePath === other.#embed.sourcePath &&
      this.#embed.resolved.documentId === other.#embed.resolved.documentId &&
      this.#embed.resolved.resourceUrl === other.#embed.resolved.resourceUrl
    );
  }

  override updateDOM(dom: HTMLElement): boolean {
    const mounted = mountedControllers.get(dom);
    if (mounted === undefined || !this.#sameAttachment(mounted.widget)) return false;
    mounted.controller.updatePreview(this.#embed.preview);
    return true;
  }

  withRange(from: number, to: number): InkbookLivePreviewWidget {
    return from === this.#embed.from && to === this.#embed.to
      ? this
      : new InkbookLivePreviewWidget(
          { ...this.#embed, from, to },
          this.#ports,
          this.#entranceState,
        );
  }

  override toDOM(view: EditorView): HTMLElement {
    const root = view.dom.createDiv({
      attr: { contenteditable: "false" },
      cls: "inkbook-root inkbook-embed-root",
    });
    root.remove();
    const button = root.createEl("button", {
      attr: { "aria-label": "Edit handwriting", type: "button" },
      cls: "inkbook-locked-preview",
    });
    const preview = createInkbookLockedPreview(
      button,
      this.#embed.preview,
      this.#ports.workScheduler(button.ownerDocument.defaultView),
      { documentId: this.#embed.resolved.documentId, documents: this.#ports.documents },
    );

    const attachmentId = `live-preview-${++nextLivePreviewAttachmentId}`;
    const hostZoomScroll = new LivePreviewZoomScrollBinding(
      view,
      root,
      this.#ports.workScheduler(root.ownerDocument.defaultView),
    );
    const controller = new PresentationController(
      {
        attachmentId,
        attachmentGeneration: 1,
        documentId: this.#embed.resolved.documentId,
        hostZoomScroll,
        embedReference: {
          documentId: this.#embed.resolved.documentId,
          from: this.#embed.from,
          kind: "live-preview",
          sourcePath: this.#embed.sourcePath,
          to: this.#embed.to,
        },
        root,
      },
      this.#ports.sessions,
      this.#ports.scheme,
      {
        ...(this.#entranceState === undefined ? {} : { entranceState: this.#entranceState }),
        contentIdentity: this.#embed.preview.contentIdentity,
        element: preview.element,
        refresh: preview.refresh,
        dispose: preview.dispose,
        requestHostMeasure: () => view.requestMeasure(),
        removeMarkdown: (range, expectedSource, mutate) =>
          removeLivePreviewMarkdown(view, range, expectedSource, mutate),
        measureRemovalSpacing: (range) => {
          const block = view.lineBlockAt(this.#embed.from);
          const first = view.lineBlockAt(range.from);
          const last = view.lineBlockAt(Math.max(range.from, range.to - 1));
          return { before: block.top - first.top, after: last.bottom - block.bottom };
        },
        ensureReady: preview.ensureReady,
        setBackgroundWait: preview.setBackgroundWait,
        setDescriptor: preview.setDescriptor,
        setAspectRatio: preview.setAspectRatio,
        setSource: preview.setSource,
      },
      this.#ports.workScheduler(root.ownerDocument.defaultView),
    );
    controller.mount();
    this.#height ??= new LivePreviewWidgetHeight();
    const releaseHeight = this.#height.observe(root);
    mountedControllers.set(root, { controller, widget: this });
    const activate = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      controller.activate();
    };
    button.addEventListener("click", activate);
    const releaseLifecycle = this.#ports.lifecycle.register(root, () => {
      releaseHeight();
      hostZoomScroll.dispose();
      button.removeEventListener("click", activate);
      mountedControllers.delete(root);
      controller.dispose();
    });
    if (releaseLifecycle === undefined) {
      releaseHeight();
      hostZoomScroll.dispose();
      button.removeEventListener("click", activate);
      mountedControllers.delete(root);
      controller.dispose();
    }
    return root;
  }

  override destroy(dom: HTMLElement): void {
    this.#ports.lifecycle.dispose(dom);
  }
}
