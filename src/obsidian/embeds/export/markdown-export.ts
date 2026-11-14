import { MarkdownRenderChild, type MarkdownPostProcessorContext } from "obsidian";
import { presentation } from "../../../domain/localization/locales/en/presentation";
import type { Localization } from "../../../domain/localization";
import type { EmbedIntegrationPorts } from "../presentation/presentation-port";
import { collectExportBlocks, correlateExportCandidates } from "./export-candidates";
import { createPreparedStaticExportSvg, createStaticExportSvg } from "./static-export-svg";
import {
  createExportPages,
  prepareExportDrawing as prepareRetainedExportDrawing,
  type ExportDrawing,
  type ExportPageOptions,
} from "./export-pages";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { applyResponsiveLockedEmbedShell } from "../presentation/locked-embed-shell";
import type { InkbookColorScheme } from "../../theme/color-scheme";
import { readExportColorScheme } from "./export-color-scheme";
import type { PreparedExportCuts } from "../../../domain/export/export-pagination";
import { StaticExportPagination } from "./print-pagination";
import { ExportGeometrySession } from "./export-geometry-session";
import type { StaticExportFragment } from "../../../persistence/export/static-export-fragments";
import type { LoadedPreviewSvg } from "../preview/safe-preview-svg";
import { hasCanonicalInkbookRootMarker } from "../preview/document-recognition";
import type { NativePdfOptions } from "./native-pdf-options";

function exportDescription(description: string | undefined, localization?: Localization): string {
  return (
    description ??
    localization?.t("presentation.export.description") ??
    presentation["presentation.export.description"]
  );
}

interface ExportResource {
  readonly drawing: ExportDrawing;
  readonly definitions: SVGSVGElement;
  readonly cuts: PreparedExportCuts | undefined;
  published: boolean;
}

interface PreparedExportGraphic {
  readonly drawing: ExportDrawing;
  readonly definitions: SVGSVGElement;
  readonly fragments: readonly StaticExportFragment[] | undefined;
}

class StaticMarkdownExport extends MarkdownRenderChild {
  readonly colorScheme: InkbookColorScheme;
  readonly abort = new AbortController();
  readonly pagination: StaticExportPagination;
  readonly geometry: ExportGeometrySession;
  readonly #mounted: Array<{
    readonly host: HTMLElement;
    readonly output: HTMLElement;
    readonly children: readonly Node[];
  }> = [];

  constructor(
    root: HTMLElement,
    scheme: InkbookColorScheme,
    scheduler: WorkScheduler,
    subscribeSchedulingProfile?: (listener: () => void) => () => void,
    nativePdfOptions?: NativePdfOptions,
  ) {
    super(root);
    this.colorScheme = scheme;
    this.pagination = new StaticExportPagination(root, nativePdfOptions);
    this.geometry = new ExportGeometrySession(
      root.ownerDocument.defaultView,
      scheduler,
      this.abort.signal,
      subscribeSchedulingProfile,
    );
  }

  mount(host: HTMLElement, output: HTMLElement): void {
    this.abort.signal.throwIfAborted();
    this.#mounted.push({ host, output, children: Array.from(host.childNodes) });
    host.replaceChildren(output);
    applyResponsiveLockedEmbedShell(output);
    host.setAttribute("data-inkbook-export", "");
  }

  override onunload(): void {
    this.abort.abort();
    this.geometry.dispose();
    this.pagination.dispose();
    for (const { host, output, children } of this.#mounted) {
      if (output.parentNode === host) {
        host.replaceChildren(...children);
        host.removeAttribute("data-inkbook-export");
      }
    }
    this.#mounted.length = 0;
  }
}

async function normalizeExportLabel(
  label: string,
  owner: StaticMarkdownExport,
  ports: EmbedIntegrationPorts,
): Promise<string> {
  // Inline emphasis/entities may change link text. Never render resource-bearing markup.
  if (
    ports.renderExportLabel === undefined ||
    /<|!\[|\[\[/u.test(label) ||
    !/[\\`*_~&]/u.test(label)
  )
    return label;
  const target = owner.containerEl.ownerDocument.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "span",
  );
  await ports.renderExportLabel(label, target, owner);
  owner.abort.signal.throwIfAborted();
  return target.textContent?.trim() ?? "";
}

async function prepareExportDrawing(
  id: string,
  owner: StaticMarkdownExport,
  ports: EmbedIntegrationPorts,
  scheduler: WorkScheduler,
): Promise<ExportResource | false> {
  const signal = owner.abort.signal;
  const document = owner.containerEl.ownerDocument;
  await ports.prepareStaticExport?.(id);
  signal.throwIfAborted();
  const descriptor = await (ports.documents.recognizeCurrent === undefined
    ? ports.documents.recognize(id, document.defaultView)
    : ports.documents.recognizeCurrent(id, document.defaultView));
  if (descriptor === false) return false;
  let graphic: Promise<PreparedExportGraphic | false> | undefined;
  const prepareGeometry = async () => {
    // Build detached graphics while the worker validates metadata; publication waits for both.
    graphic = prepareExportGraphic(owner, descriptor, scheduler);
    const [cuts, prepared] = await Promise.all([
      owner.geometry.prepare(descriptor.safeSvg, descriptor.safeStaticProof),
      graphic,
    ]);
    return { cuts, fragments: prepared === false ? undefined : prepared.fragments };
  };
  const geometry =
    ports.exportGeometryCache === undefined
      ? await prepareGeometry()
      : await ports.exportGeometryCache.prepare(descriptor, prepareGeometry, signal);
  const prepared = await (graphic ??
    prepareExportGraphic(owner, descriptor, scheduler, geometry.fragments));
  return prepared === false
    ? false
    : {
        drawing: prepared.drawing,
        definitions: prepared.definitions,
        cuts: geometry.cuts,
        published: false,
      };
}

async function prepareExportGraphic(
  owner: StaticMarkdownExport,
  descriptor: LoadedPreviewSvg,
  scheduler: WorkScheduler,
  cachedFragments?: readonly StaticExportFragment[],
): Promise<PreparedExportGraphic | false> {
  const document = owner.containerEl.ownerDocument;
  const options = {
    workScheduler: scheduler,
    signal: owner.abort.signal,
    colorScheme: owner.colorScheme,
  };
  const prepared =
    cachedFragments === undefined
      ? await createPreparedStaticExportSvg(document, descriptor, options)
      : undefined;
  if (
    cachedFragments === undefined &&
    prepared === undefined &&
    (options.signal.aborted || hasCanonicalInkbookRootMarker(descriptor.safeSvg))
  )
    return false;
  const definitions = prepared?.svg ?? (await createStaticExportSvg(document, descriptor, options));
  if (definitions === undefined) return false;
  const fragments = cachedFragments ?? prepared?.fragments;
  const drawing = await prepareRetainedExportDrawing(definitions, fragments, {
    scheduler,
    signal: options.signal,
  });
  return { drawing, definitions, fragments };
}

function mountStaticExport(
  owner: StaticMarkdownExport,
  resource: ExportResource,
  output: {
    readonly host: HTMLElement;
    readonly pages: HTMLElement;
    readonly options: ExportPageOptions;
  },
): void {
  if (!resource.published) output.pages.prepend(resource.definitions);
  owner.mount(output.host, output.pages);
  owner.pagination.register({
    host: output.host,
    container: output.pages,
    drawing: resource.drawing,
    cuts: resource.cuts,
    options: output.options,
  });
  resource.published = true;
}

async function waitForExportFonts(document: Document, signal: AbortSignal): Promise<void> {
  if (document.fonts === undefined) return;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("Export font loading was cancelled.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // FontFaceSet.ready includes the layout that discovers fonts in retained SVG references.
    await Promise.race([document.fonts.ready, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Sectionless renderers receive complete, inert graphics without mounting a presentation. */
export async function renderStaticMarkdownEmbeds(
  root: HTMLElement,
  context: MarkdownPostProcessorContext,
  ports: EmbedIntegrationPorts,
): Promise<void> {
  if (ports.readMarkdownSource === undefined || !context.sourcePath) return;
  const scheduler = ports.workScheduler(root.ownerDocument.defaultView);
  const owner = new StaticMarkdownExport(
    root,
    readExportColorScheme(root),
    scheduler,
    ports.subscribeSchedulingProfile,
    ports.bindNativePdfOptions?.(root, context.sourcePath),
  );
  context.addChild(owner);
  const signal = owner.abort.signal;
  let releaseSchedulingProfile: (() => void) | undefined;
  try {
    // The host publishes native images after invoking its postprocessors. Read source
    // first so the returned async processor resumes after that synchronous publication.
    const source = await ports.readMarkdownSource(context.sourcePath);
    signal.throwIfAborted();
    if (source === undefined) return;
    const blocks = await collectExportBlocks(root, scheduler, signal);
    if (blocks.length === 0) return;
    const candidates = await correlateExportCandidates(
      blocks,
      source,
      context.sourcePath,
      ports.resolveDocument,
      (label) => normalizeExportLabel(label, owner, ports),
    );
    signal.throwIfAborted();
    if (candidates.length === 0) return;
    releaseSchedulingProfile = ports.acquireSchedulingProfile?.(owner);
    const drawings = new Map<string, ExportResource | false>();
    let hasFonts = false;
    for (const candidate of candidates) {
      signal.throwIfAborted();
      const id = candidate.resolved.documentId;
      if (!drawings.has(id)) {
        drawings.set(id, await prepareExportDrawing(id, owner, ports, scheduler));
      }
      const resource = drawings.get(id);
      if (resource === undefined || resource === false) continue;
      const options = {
        colorScheme: owner.colorScheme,
        description: exportDescription(candidate.description, ports.localization),
        ...(candidate.width === undefined ? {} : { width: candidate.width }),
      };
      const pages = await createExportPages(root.ownerDocument, resource.drawing, {
        scheduler,
        signal,
        ...options,
      });
      if (!signal.aborted && root.contains(candidate.host)) {
        mountStaticExport(owner, resource, { host: candidate.host, pages, options });
        hasFonts ||= resource.drawing.hasFonts === true;
      }
    }
    if (hasFonts) await waitForExportFonts(root.ownerDocument, signal);
    signal.throwIfAborted();
    owner.pagination.start();
  } catch (error: unknown) {
    if (!signal.aborted) throw error;
  } finally {
    releaseSchedulingProfile?.();
    owner.geometry.dispose();
  }
}
