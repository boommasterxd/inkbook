import {
  MarkdownRenderChild,
  type MarkdownPostProcessor,
  type MarkdownPostProcessorContext,
} from "obsidian";

import { findMarkdownInkbookEmbeds } from "./markdown-embed";
import type { InkbookDocumentRecognition } from "./document-recognition";
import { createInkbookLockedPreview } from "./locked-preview";
import { PresentationController } from "./presentation-controller";
import type { EmbedIntegrationPorts, ResolvedInkbookDocument } from "./presentation-port";
import { samePreviewContentIdentity } from "./safe-preview-svg";

let nextReadingAttachmentId = 0;

interface ReadingViewCandidate {
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
): ReadingViewCandidate | undefined {
  const section = context.getSectionInfo(element);
  if (section === null) {
    return undefined;
  }
  if (isInsideCode(element)) return undefined;
  const embeds = findMarkdownInkbookEmbeds(section.text);
  if (embeds.length !== 1) return undefined;
  const embed = embeds[0];
  if (embed === undefined) return undefined;
  if (section.text.trim() !== embed.markdown) return undefined;
  const resolved = resolveDocument(embed.linkpath, context.sourcePath);
  if (resolved === undefined) return undefined;
  return {
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
  readonly #controller: PresentationController;
  readonly #documentId: string;
  readonly #nativeHost: HTMLElement;
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
    const root = candidate.host.createDiv({ cls: "inkbook-root inkbook-embed-root" });
    root.remove();
    candidate.host.replaceWith(root);
    const button = root.createEl("button", {
      attr: { "aria-label": "Edit handwriting", type: "button" },
      cls: "inkbook-locked-preview",
    });
    const preview = createInkbookLockedPreview(button, previewDescriptor);
    super(root);
    this.#button = button;
    this.#documentId = candidate.resolved.documentId;
    this.#nativeHost = candidate.host;
    this.#lifecycle = ports.lifecycle;
    this.#ports = ports;
    this.#previewIdentity = previewDescriptor.contentIdentity;
    this.#root = root;
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
        setDescriptor: preview.setDescriptor,
        setAspectRatio: preview.setAspectRatio,
        setSource: preview.setSource,
      },
    );
  }

  override onload(): void {
    this.#releaseLifecycle = this.#lifecycle.register(this.#root, () => {
      this.unload();
    });
    if (this.#releaseLifecycle === undefined) return;
    this.#controller.mount();
    this.#releaseRecognition = this.#ports.documents.subscribe((documentId) => {
      if (documentId === this.#documentId) void this.#refreshRecognition();
    });
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
    if (this.#root.isConnected) this.#root.replaceWith(this.#nativeHost);
  }

  async #refreshRecognition(): Promise<void> {
    const generation = ++this.#recognitionGeneration;
    const documentId = this.#documentId;
    const recognized = await this.#ports.documents.recognize(documentId);
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

export function createReadingViewPostProcessor(
  ports: EmbedIntegrationPorts,
): MarkdownPostProcessor {
  return (element, context): Promise<void> | void => {
    const initial = recognizeReadingViewCandidate(element, context, ports.resolveDocument);
    if (initial === undefined) return;
    const attach = (preview: Exclude<InkbookDocumentRecognition, false>): void => {
      const candidate = recognizeReadingViewCandidate(element, context, ports.resolveDocument);
      if (candidate?.resolved.documentId !== initial.resolved.documentId) return;
      context.addChild(new InkbookReadingRenderChild(candidate, preview, ports));
    };
    const cached = ports.documents.cached(initial.resolved.documentId);
    if (cached !== undefined && cached !== false) return attach(cached);
    if (cached === false) return;
    return ports.documents.recognize(initial.resolved.documentId).then((recognized) => {
      if (recognized === false) return;
      const current = ports.documents.cached(initial.resolved.documentId);
      if (
        current !== undefined &&
        current !== false &&
        samePreviewContentIdentity(current.contentIdentity, recognized.contentIdentity)
      ) {
        attach(recognized);
      }
    });
  };
}
