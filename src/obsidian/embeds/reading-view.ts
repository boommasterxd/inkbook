import {
  MarkdownRenderChild,
  type MarkdownPostProcessor,
  type MarkdownPostProcessorContext,
} from "obsidian";

import { findMarkdownInkbookEmbeds } from "./markdown-embed";
import { browserLockedPreviewSchemeCapability } from "./locked-preview-scheme-capability";
import { PresentationController } from "./presentation-controller";
import type { EmbedIntegrationPorts, ResolvedInkbookDocument } from "./presentation-port";

let nextReadingAttachmentId = 0;

interface ReadingViewCandidate {
  readonly host: HTMLElement;
  readonly image: HTMLImageElement;
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

function canonicalResourceUrl(value: string, baseUrl: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return undefined;
  }
}

function renderedImageUrl(image: HTMLImageElement): string {
  return image.currentSrc.trim() || image.src.trim();
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
  const imageElements = element.getElementsByTagName("img");
  const images: HTMLImageElement[] = [];
  for (let index = 0; index < imageElements.length; index += 1) {
    const image = imageElements.item(index);
    if (image !== null && !isInsideCode(image)) images.push(image);
  }
  if (images.length !== 1) return undefined;
  const embed = embeds[0];
  if (embed === undefined) return undefined;
  const resolved = resolveDocument(embed.linkpath, context.sourcePath);
  if (resolved === undefined) return undefined;
  const resourceUrl = canonicalResourceUrl(resolved.resourceUrl, element.ownerDocument.baseURI);
  const image = images[0];
  if (resourceUrl === undefined || image === undefined) return undefined;
  const imageUrl = canonicalResourceUrl(renderedImageUrl(image), element.ownerDocument.baseURI);
  if (imageUrl !== resourceUrl) return undefined;
  return {
    host: element,
    image,
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
  readonly #image: HTMLImageElement;
  readonly #root: HTMLSpanElement;
  readonly #lifecycle: EmbedIntegrationPorts["lifecycle"];
  #releaseLifecycle: (() => void) | undefined;

  constructor(candidate: ReadingViewCandidate, ports: EmbedIntegrationPorts) {
    const root = candidate.host.createSpan({ cls: "inkbook-root inkbook-embed-root" });
    const button = root.createEl("button", {
      attr: { "aria-label": "Edit handwriting", type: "button" },
      cls: "inkbook-locked-preview",
    });
    button.append(candidate.image);
    super(root);
    this.#button = button;
    this.#image = candidate.image;
    this.#lifecycle = ports.lifecycle;
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
      { capability: browserLockedPreviewSchemeCapability, image: candidate.image },
    );
  }

  override onload(): void {
    this.#releaseLifecycle = this.#lifecycle.register(this.#root, () => {
      this.unload();
    });
    if (this.#releaseLifecycle === undefined) return;
    this.#controller.mount();
    this.registerDomEvent(this.#button, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.#controller.activate();
    });
  }

  override onunload(): void {
    this.#releaseLifecycle?.();
    this.#releaseLifecycle = undefined;
    this.#controller.dispose();
    if (this.#root.isConnected) {
      this.#root.replaceWith(this.#controller.lockedPreviewImage ?? this.#image);
    }
  }
}

export function createReadingViewPostProcessor(
  ports: EmbedIntegrationPorts,
): MarkdownPostProcessor {
  return (element, context): Promise<void> | void => {
    const initial = recognizeReadingViewCandidate(element, context, ports.resolveDocument);
    if (initial === undefined) return;
    const attach = (): void => {
      const candidate = recognizeReadingViewCandidate(element, context, ports.resolveDocument);
      if (candidate?.resolved.documentId !== initial.resolved.documentId) return;
      context.addChild(new InkbookReadingRenderChild(candidate, ports));
    };
    const cached = ports.documents.cached(initial.resolved.documentId);
    if (cached === true) return attach();
    if (cached === false) return;
    return ports.documents.recognize(initial.resolved.documentId).then((recognized) => {
      if (recognized) attach();
    });
  };
}
