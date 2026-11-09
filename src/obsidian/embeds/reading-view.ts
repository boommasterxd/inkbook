import {
  MarkdownRenderChild,
  type MarkdownPostProcessor,
  type MarkdownPostProcessorContext,
} from "obsidian";

import { ReadingMarkdownIndex } from "./reading-markdown-index";
import { updateEmbedDescription } from "./presentation/embed-description";
import type { InkbookDocumentRecognition } from "./preview/document-recognition";
import { createInkbookLockedPreview } from "./preview/locked-preview";
import { PresentationController } from "./presentation/presentation-controller";
import type {
  EmbedIntegrationPorts,
  ResolvedInkbookDocument,
} from "./presentation/presentation-port";
import { samePreviewContentIdentity } from "./preview/safe-preview-svg";
import { renderStaticMarkdownEmbeds } from "./export/markdown-export";

let nextReadingAttachmentId = 0;

interface ReadingViewCandidate {
  readonly linkpath: string;
  readonly description?: string;
  readonly width?: number;
  readonly host: HTMLElement;
  readonly markdown: string;
  readonly range: { readonly from: number; readonly to: number };
  readonly resolved: ResolvedInkbookDocument;
  readonly section: {
    readonly lineEnd: number;
    readonly lineStart: number;
    readonly text: string;
  };
  readonly sourcePath: string;
}

function isInsideCode(element: HTMLElement): boolean {
  return element.closest("code, pre") !== null;
}

function recognizeReadingViewCandidate(
  element: HTMLElement,
  context: MarkdownPostProcessorContext,
  resolveDocument: EmbedIntegrationPorts["resolveDocument"],
  markdownIndex: ReadingMarkdownIndex,
): ReadingViewCandidate | undefined {
  const section = context.getSectionInfo(element);
  if (section === null) {
    return undefined;
  }
  if (isInsideCode(element)) return undefined;
  const embed = markdownIndex.standaloneEmbed(context.sourcePath, section);
  if (embed === undefined) return undefined;
  const resolved = resolveDocument(embed.linkpath, context.sourcePath);
  if (resolved === undefined) return undefined;
  return {
    linkpath: embed.linkpath,
    ...(embed.description === undefined ? {} : { description: embed.description }),
    ...(embed.width === undefined ? {} : { width: embed.width }),
    host: element,
    markdown: embed.markdown,
    range: { from: embed.from, to: embed.to },
    resolved,
    section,
    sourcePath: context.sourcePath,
  };
}

class InkbookReadingRenderChild extends MarkdownRenderChild {
  readonly #button: HTMLButtonElement;
  readonly #refreshPreview: () => void;
  readonly #controller: PresentationController;
  readonly #documentId: string;
  readonly #nativeHost: HTMLElement;
  readonly #nativeChildren: readonly Node[];
  readonly #root: HTMLDivElement;
  readonly #lifecycle: EmbedIntegrationPorts["lifecycle"];
  readonly #ports: EmbedIntegrationPorts;
  #previewIdentity: Exclude<InkbookDocumentRecognition, false>["contentIdentity"];
  #recognitionGeneration = 0;
  #releaseRecognition: (() => void) | undefined;
  #releaseLifecycle: (() => void) | undefined;

  constructor(
    candidate: ReadingViewCandidate,
    previewDescriptor: Exclude<InkbookDocumentRecognition, false>,
    ports: EmbedIntegrationPorts,
  ) {
    const nativeChildren = Array.from(candidate.host.childNodes);
    const root = candidate.host.createDiv({ cls: "inkbook-root inkbook-embed-root" });
    if (candidate.width !== undefined)
      root.style.setProperty("--inkbook-embed-inline-size", `${String(candidate.width)}px`);
    candidate.host.replaceChildren(root);
    const button = root.createEl("button", {
      attr: { type: "button" },
      cls: "inkbook-locked-preview",
    });
    const preview = createInkbookLockedPreview(
      button,
      previewDescriptor,
      ports.workScheduler(button.ownerDocument.defaultView),
      { documentId: candidate.resolved.documentId, documents: ports.documents },
    );
    updateEmbedDescription(root, button, candidate.description, ports.localization?.t);
    super(candidate.host);
    this.#button = button;
    this.#refreshPreview = preview.refresh;
    this.#documentId = candidate.resolved.documentId;
    this.#nativeHost = candidate.host;
    this.#nativeChildren = nativeChildren;
    this.#lifecycle = ports.lifecycle;
    this.#ports = ports;
    this.#previewIdentity = previewDescriptor.contentIdentity;
    this.#root = root;
    this.register(
      ports.localization?.subscribe(() => {
        updateEmbedDescription(root, button, candidate.description, ports.localization?.t);
      }) ?? (() => undefined),
    );
    const attachmentId = `reading-${++nextReadingAttachmentId}`;
    this.#controller = new PresentationController(
      {
        attachmentId,
        attachmentGeneration: 1,
        documentId: candidate.resolved.documentId,
        embedReference: {
          documentId: candidate.resolved.documentId,
          kind: "reading-view",
          markdown: candidate.markdown,
          section: candidate.section,
          sectionFrom: candidate.range.from,
          sectionTo: candidate.range.to,
          sourcePath: candidate.sourcePath,
        },
        root,
      },
      ports.sessions,
      ports.scheme,
      {
        contentIdentity: previewDescriptor.contentIdentity,
        element: preview.element,
        refresh: preview.refresh,
        releaseHiddenSurface: preview.releaseHiddenSurface,
        setColorScheme: preview.setColorScheme,
        dispose: preview.dispose,
        ensureReady: preview.ensureReady,
        setBackgroundWait: preview.setBackgroundWait,
        setDescriptor: preview.setDescriptor,
        setAspectRatio: preview.setAspectRatio,
        setSource: preview.setSource,
      },
      ports.workScheduler(root.ownerDocument.defaultView),
    );
  }

  override onload(): void {
    this.#releaseLifecycle = this.#lifecycle.register(
      this.#root,
      () => {
        this.unload();
      },
      this.#refreshPreview,
    );
    if (this.#releaseLifecycle === undefined) return;
    this.#controller.mount();
    this.#releaseRecognition = this.#ports.documents.subscribe(
      () => void this.#refreshRecognition(),
      this.#documentId,
    );
    this.registerDomEvent(this.#button, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.#controller.activate();
    });
  }

  override onunload(): void {
    this.#recognitionGeneration += 1;
    this.#releaseRecognition?.();
    this.#releaseRecognition = undefined;
    this.#releaseLifecycle?.();
    this.#releaseLifecycle = undefined;
    this.#controller.dispose();
    if (this.#root.parentNode === this.#nativeHost) {
      this.#nativeHost.replaceChildren(...this.#nativeChildren);
    }
  }

  async #refreshRecognition(): Promise<void> {
    const generation = ++this.#recognitionGeneration;
    const documentId = this.#documentId;
    const recognized = await this.#ports.documents.recognize(
      documentId,
      this.#root.ownerDocument.defaultView,
    );
    if (generation !== this.#recognitionGeneration) return;
    const current = this.#ports.documents.cached(documentId);
    if (recognized === false) {
      if (current === false) this.unload();
      return;
    }
    if (
      current === undefined ||
      current === false ||
      !samePreviewContentIdentity(current.contentIdentity, recognized.contentIdentity)
    ) {
      return;
    }
    if (samePreviewContentIdentity(this.#previewIdentity, recognized.contentIdentity)) return;
    this.#previewIdentity = recognized.contentIdentity;
    this.#controller.updatePreview(recognized);
  }
}

/** Keeps the native image mounted until its current file is proven safe. */
class NativeReadingRenderChild extends MarkdownRenderChild {
  #generation = 0;
  #disposed = false;
  #presentation: InkbookReadingRenderChild | undefined;
  #releaseRecognition: (() => void) | undefined;
  #releaseLifecycle: (() => void) | undefined;

  constructor(
    readonly candidate: ReadingViewCandidate,
    readonly context: MarkdownPostProcessorContext,
    readonly ports: EmbedIntegrationPorts,
    readonly markdownIndex: ReadingMarkdownIndex,
  ) {
    super(candidate.host);
  }

  override onload(): void {
    this.#releaseLifecycle = this.ports.lifecycle.register(this.containerEl, () => this.unload());
    if (this.#releaseLifecycle === undefined) return this.unload();
    this.#releaseRecognition = this.ports.documents.subscribe(
      () => void this.#refresh(),
      this.candidate.resolved.documentId,
    );
    void this.#refresh();
  }

  override onunload(): void {
    this.#disposed = true;
    this.#generation += 1;
    this.#releaseRecognition?.();
    this.#releaseLifecycle?.();
    this.#releaseRecognition = undefined;
    this.#releaseLifecycle = undefined;
    this.#presentation?.unload();
    this.#presentation = undefined;
  }

  async #refresh(): Promise<void> {
    const generation = ++this.#generation;
    const { candidate: initial, ports } = this;
    const recognized = await ports.documents
      .recognize(initial.resolved.documentId, this.containerEl.ownerDocument.defaultView)
      .catch(() => false as const);
    if (this.#disposed || generation !== this.#generation) return;
    const candidate = recognizeReadingViewCandidate(
      this.containerEl,
      this.context,
      () => initial.resolved,
      this.markdownIndex,
    );
    const resolved =
      candidate === undefined
        ? undefined
        : ports.resolveDocument(candidate.linkpath, candidate.sourcePath);
    const current = ports.documents.cached(initial.resolved.documentId);
    if (
      candidate === undefined ||
      candidate.markdown !== initial.markdown ||
      candidate.sourcePath !== initial.sourcePath ||
      candidate.range.from !== initial.range.from ||
      candidate.range.to !== initial.range.to
    ) {
      this.unload();
      return;
    }
    if (current === false || resolved?.documentId !== initial.resolved.documentId) {
      this.#presentation?.unload();
      this.#presentation = undefined;
      return;
    }
    if (
      recognized === false ||
      current === undefined ||
      !samePreviewContentIdentity(current.contentIdentity, recognized.contentIdentity) ||
      this.#presentation !== undefined
    )
      return;
    this.#presentation = new InkbookReadingRenderChild(candidate, recognized, ports);
    this.#presentation.load();
  }
}

export function createReadingViewPostProcessor(
  ports: EmbedIntegrationPorts,
  markdownIndex = new ReadingMarkdownIndex(),
): MarkdownPostProcessor {
  return (element, context): Promise<void> | void => {
    const initial = recognizeReadingViewCandidate(
      element,
      context,
      ports.resolveDocument,
      markdownIndex,
    );
    if (initial === undefined) {
      if (context.getSectionInfo(element) === null)
        return renderStaticMarkdownEmbeds(element, context, ports);
      return;
    }
    context.addChild(new NativeReadingRenderChild(initial, context, ports, markdownIndex));
  };
}
