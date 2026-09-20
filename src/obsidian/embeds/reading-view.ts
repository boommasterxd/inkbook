import {
  MarkdownRenderChild,
  type MarkdownPostProcessor,
  type MarkdownPostProcessorContext,
} from "obsidian";

import { findMarkdownInkbookEmbeds } from "./markdown-embed";
import type { InkbookDocumentRecognition } from "./document-recognition";
import { createLoadingPlaceholder, type LoadingPlaceholder } from "./loading-placeholder";
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

function readingSectionRange(section: ReadingViewCandidate["section"]) {
  if (
    !Number.isSafeInteger(section.lineStart) ||
    section.lineStart < 0 ||
    !Number.isSafeInteger(section.lineEnd) ||
    section.lineEnd < section.lineStart
  )
    return undefined;
  let from = 0;
  for (let line = 0; line < section.lineStart; line += 1) {
    const newline = section.text.indexOf("\n", from);
    if (newline < 0) return undefined;
    from = newline + 1;
  }
  let to = from;
  for (let line = section.lineStart; line <= section.lineEnd; line += 1) {
    const newline = section.text.indexOf("\n", to);
    if (newline < 0)
      return line === section.lineEnd ? { from, to: section.text.length } : undefined;
    if (line === section.lineEnd) return { from, to: newline };
    to = newline + 1;
  }
  return undefined;
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
  const range = readingSectionRange(section);
  if (range === undefined) return undefined;
  const embeds = findMarkdownInkbookEmbeds(section.text).filter(
    (embed) => embed.from >= range.from && embed.to <= range.to,
  );
  if (embeds.length !== 1) return undefined;
  const embed = embeds[0];
  if (embed === undefined) return undefined;
  if (section.text.slice(range.from, range.to).trim() !== embed.markdown) return undefined;
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
    pending?: {
      readonly children: readonly Node[];
      readonly height: number;
      readonly startedAt: number;
    },
  ) {
    const nativeChildren = pending?.children ?? Array.from(candidate.host.childNodes);
    const root = candidate.host.createDiv({ cls: "inkbook-root inkbook-embed-root" });
    candidate.host.replaceChildren(root);
    const button = root.createEl("button", {
      attr: { "aria-label": "Edit handwriting", type: "button" },
      cls: "inkbook-locked-preview",
    });
    const preview = createInkbookLockedPreview(button, previewDescriptor);
    super(candidate.host);
    this.#button = button;
    this.#documentId = candidate.resolved.documentId;
    this.#nativeHost = candidate.host;
    this.#nativeChildren = nativeChildren;
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
        ...(pending === undefined
          ? {}
          : {
              entranceState: {
                presented: false,
                initialHeight: pending.height,
                loadingStartedAt: pending.startedAt,
              },
            }),
        contentIdentity: previewDescriptor.contentIdentity,
        element: preview.element,
        refresh: preview.refresh,
        dispose: preview.dispose,
        ensureReady: preview.ensureReady,
        setBackgroundWait: preview.setBackgroundWait,
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
    if (this.#root.parentNode === this.#nativeHost) {
      this.#nativeHost.replaceChildren(...this.#nativeChildren);
    }
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

class PendingReadingRenderChild extends MarkdownRenderChild {
  readonly children: readonly Node[];
  readonly placeholder: HTMLElement;
  readonly #loading: LoadingPlaceholder;
  #disposed = false;
  #releaseLifecycle: (() => void) | undefined;

  constructor(
    host: HTMLElement,
    readonly ports: EmbedIntegrationPorts,
  ) {
    super(host);
    this.children = Array.from(host.childNodes);
    this.#loading = createLoadingPlaceholder(host, {
      motion: ports.sessions.getMotionPreference?.() ?? "system",
      scheme: ports.scheme,
    });
    this.placeholder = this.#loading.element;
    host.replaceChildren(this.placeholder);
  }

  get current(): boolean {
    return !this.#disposed && this.placeholder.parentNode === this.containerEl;
  }

  get loadingStartedAt(): number {
    return this.#loading.startedAt;
  }

  get renderedHeight(): number {
    return this.#loading.renderedHeight;
  }

  override onload(): void {
    this.#releaseLifecycle = this.ports.lifecycle.register(this.placeholder, () => this.unload());
    if (this.#releaseLifecycle === undefined) this.unload();
  }

  override onunload(): void {
    if (this.current) this.containerEl.replaceChildren(...this.children);
    this.#disposed = true;
    this.#loading.dispose();
    this.#releaseLifecycle?.();
    this.#releaseLifecycle = undefined;
  }
}

export function createReadingViewPostProcessor(
  ports: EmbedIntegrationPorts,
): MarkdownPostProcessor {
  return (element, context): Promise<void> | void => {
    const initial = recognizeReadingViewCandidate(element, context, ports.resolveDocument);
    if (initial === undefined) return;
    const cached = ports.documents.cached(initial.resolved.documentId);
    if (cached !== undefined && cached !== false) {
      context.addChild(new InkbookReadingRenderChild(initial, cached, ports));
      return;
    }
    if (cached === false) return;
    const pending = new PendingReadingRenderChild(element, ports);
    context.addChild(pending);
    return ports.documents
      .recognize(initial.resolved.documentId)
      .then((recognized) => {
        if (!pending.current || recognized === false) return;
        const candidate = recognizeReadingViewCandidate(element, context, ports.resolveDocument);
        const current = ports.documents.cached(initial.resolved.documentId);
        if (
          candidate?.resolved.documentId === initial.resolved.documentId &&
          candidate.markdown === initial.markdown &&
          candidate.sourcePath === initial.sourcePath &&
          candidate.range.from === initial.range.from &&
          candidate.range.to === initial.range.to &&
          current !== undefined &&
          current !== false &&
          samePreviewContentIdentity(current.contentIdentity, recognized.contentIdentity)
        ) {
          context.addChild(
            new InkbookReadingRenderChild(candidate, recognized, ports, {
              children: pending.children,
              height: pending.renderedHeight,
              startedAt: pending.loadingStartedAt,
            }),
          );
        }
      })
      .catch(() => undefined)
      .finally(() => pending.unload());
  };
}
