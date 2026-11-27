import { type EditorView, WidgetType } from "@codemirror/view";

import {
  createInkbookLockedPreview,
  type InkbookLockedPreviewGeometry,
} from "../preview/locked-preview";
import {
  observeEmbedDescriptionLanguage,
  updateEmbedDescription,
} from "../presentation/embed-description";
import { removeLivePreviewMarkdown } from "./live-preview-removal";
import { LivePreviewWidgetHeight } from "./live-preview-widget-height";
import { LivePreviewZoomScrollBinding } from "./live-preview-zoom-scroll";
import { PresentationController } from "../presentation/presentation-controller";
import type { EmbedIntegrationPorts } from "../presentation/presentation-port";
import type { PresentationEntranceState } from "../presentation/presentation-entrance";
import type { ResolvedInkbookDocument } from "../presentation/presentation-port";

export interface VisibleEmbed {
  readonly description?: string;
  readonly width?: number;
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
  readonly preview: InkbookLockedPreviewGeometry;
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
      this.#embed.from === other.#embed.from &&
      this.#embed.to === other.#embed.to &&
      this.#embed.description === other.#embed.description &&
      this.#embed.width === other.#embed.width &&
      this.#samePreviewGeometry(other)
    );
  }

  #samePreviewGeometry(other: InkbookLivePreviewWidget): boolean {
    const preview = this.#embed.preview;
    const next = other.#embed.preview;
    // Keep the lightweight identity stable across wrappers. A fresh validation can also retry a failed mount.
    return (
      preview.aspectRatio === next.aspectRatio && preview.contentIdentity === next.contentIdentity
    );
  }

  #sameAttachment(other: InkbookLivePreviewWidget): boolean {
    return (
      this.#ports === other.#ports &&
      this.#entranceState === other.#entranceState &&
      (this.#entranceState !== undefined ||
        (this.#embed.from === other.#embed.from && this.#embed.to === other.#embed.to)) &&
      this.#embed.sourcePath === other.#embed.sourcePath &&
      this.#embed.resolved.documentId === other.#embed.resolved.documentId
    );
  }

  override updateDOM(dom: HTMLElement): boolean {
    const mounted = mountedControllers.get(dom);
    if (mounted === undefined || !this.#sameAttachment(mounted.widget)) return false;
    if (!mounted.controller.updateLivePreviewRange(this.#embed.from, this.#embed.to)) return false;
    updateEmbedDescription(dom, undefined, this.#embed.description, this.#ports.localization?.t);
    this.#applyWidth(dom);
    mountedControllers.set(dom, { controller: mounted.controller, widget: this });
    if (!this.#samePreviewGeometry(mounted.widget))
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
    this.#applyWidth(root);
    const button = root.createEl("button", {
      attr: { type: "button" },
      cls: "inkbook-locked-preview",
    });
    const preview = createInkbookLockedPreview(
      button,
      this.#embed.preview,
      this.#ports.workScheduler(button.ownerDocument.defaultView),
      {
        documentId: this.#embed.resolved.documentId,
        documents: this.#ports.documents,
        waitForLayout: true,
      },
    );
    updateEmbedDescription(root, button, this.#embed.description, this.#ports.localization?.t);

    const attachmentId = `live-preview-${++nextLivePreviewAttachmentId}`;
    const hostZoomScroll = new LivePreviewZoomScrollBinding(
      view,
      root,
      this.#ports.workScheduler(root.ownerDocument.defaultView),
    );
    const initialFrom = this.#embed.from;
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
        getMountedIdentity: preview.getMountedIdentity,
        element: preview.element,
        refresh: preview.refresh,
        releaseHiddenSurface: preview.releaseHiddenSurface,
        setColorScheme: preview.setColorScheme,
        dispose: preview.dispose,
        requestHostMeasure: () => view.requestMeasure(),
        removeMarkdown: (range, expectedSource, mutate) =>
          removeLivePreviewMarkdown(view, range, expectedSource, mutate),
        measureRemovalSpacing: (range) => {
          const mounted = mountedControllers.get(root);
          const from = mounted === undefined ? initialFrom : mounted.widget.#embed.from;
          const block = view.lineBlockAt(from);
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
    const releaseHeight = this.#height.observe(root, preview.setLayoutVisible);
    mountedControllers.set(root, { controller, widget: this });
    const activate = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      controller.activate();
    };
    button.addEventListener("click", activate);
    const releaseLanguage = this.#observeLanguage(root);
    const dispose = (): void => {
      releaseLanguage?.();
      releaseHeight();
      hostZoomScroll.dispose();
      button.removeEventListener("click", activate);
      mountedControllers.delete(root);
      controller.dispose();
    };
    const releaseLifecycle = this.#ports.lifecycle.register(root, dispose, preview.refresh);
    if (releaseLifecycle === undefined) dispose();
    return root;
  }

  override destroy(dom: HTMLElement): void {
    this.#ports.lifecycle.dispose(dom);
  }

  #observeLanguage(root: HTMLElement): (() => void) | undefined {
    return observeEmbedDescriptionLanguage(
      root,
      () => {
        const mounted = mountedControllers.get(root);
        return mounted && mounted.widget.#embed.description;
      },
      this.#ports.localization,
    );
  }

  #applyWidth(root: HTMLElement): void {
    if (this.#embed.width === undefined) root.style.removeProperty("--inkbook-embed-inline-size");
    else root.style.setProperty("--inkbook-embed-inline-size", `${String(this.#embed.width)}px`);
  }
}
