import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { applyColorScheme, type InkbookColorScheme } from "../../theme/color-scheme";
import type { StaticExportFragment } from "../../../persistence/export/static-export-fragments";
import {
  exportFragmentReferences,
  retainExportFragments,
  type ExportFragmentTree,
} from "./export-fragment-tree";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
let nextDrawing = 0;

export interface ExportDrawing {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly fragments?: readonly ExportFragmentTree[];
}

export interface ExportPageOptions {
  readonly description?: string;
  readonly colorScheme?: InkbookColorScheme;
  readonly start?: number;
  readonly end?: number;
  readonly deferGraphic?: boolean;
}

/** Retain geometry once; subsequent pages and occurrences reference the same drawing. */
export function retainExportDrawing(svg: SVGSVGElement): ExportDrawing {
  const viewBox = (svg.getAttribute("viewBox") ?? "").split(/\s+/u).map(Number);
  const width = viewBox[2];
  const height = viewBox[3];
  if (
    width === undefined ||
    height === undefined ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("The Inkbook export has no valid page dimensions.");
  const id = `inkbook-export-drawing-${++nextDrawing}`;
  const group = svg.ownerDocument.createElementNS(SVG_NAMESPACE, "g");
  group.setAttribute("id", id);
  while (svg.firstChild !== null) group.append(svg.firstChild);
  const definitions = svg.ownerDocument.createElementNS(SVG_NAMESPACE, "defs");
  definitions.append(group);
  svg.append(definitions);
  svg.setAttribute("class", "inkbook-export-definitions");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.removeAttribute("role");
  svg.removeAttribute("aria-label");
  return { id, width, height };
}

/** Build export-only reference groups once, before any synchronous print callback. */
export async function prepareExportDrawing(
  svg: SVGSVGElement,
  fragments: readonly StaticExportFragment[] | undefined,
  options: { readonly scheduler: WorkScheduler; readonly signal: AbortSignal },
): Promise<ExportDrawing> {
  const drawing = retainExportDrawing(svg);
  const group = svg.firstElementChild?.firstElementChild as SVGGElement;
  if (fragments === undefined) return drawing;
  const trees = await retainExportFragments(group, fragments, options);
  return trees === undefined ? drawing : { ...drawing, fragments: trees };
}

/** The locked viewport fragments naturally; its complete SVG stays out of block flow. */
export async function createExportPages(
  document: Document,
  drawing: ExportDrawing,
  options: {
    readonly scheduler: WorkScheduler;
    readonly signal: AbortSignal;
    readonly description?: string;
    readonly colorScheme?: InkbookColorScheme;
  },
): Promise<HTMLElement> {
  const pending = options.scheduler.checkpoint(options.signal, "background");
  if (pending !== undefined) await pending;
  options.signal.throwIfAborted();
  return createExportPage(document, drawing, options);
}

/** Print publication references retained geometry; it never rebuilds drawing paths. */
export function createExportPage(
  document: Document,
  drawing: ExportDrawing,
  options: ExportPageOptions,
): HTMLElement {
  const start = options.start ?? 0;
  const end = options.end ?? drawing.height;
  // Windowless export documents still own their detached HTML and SVG nodes.
  const container = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  container.className = "inkbook-root inkbook-embed-root inkbook-static-export";
  container.dataset.inkbookState = "locked";
  container.dataset.inkbookRangeStart = String(start);
  container.dataset.inkbookRangeEnd = String(end);
  applyColorScheme(container, options.colorScheme ?? "light");
  const shell = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  shell.className = "inkbook-locked-preview";
  const media = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  media.className = "inkbook-locked-preview-media inkbook-export-pages";
  media.style.setProperty("--inkbook-preview-aspect-ratio", String(drawing.width / (end - start)));
  shell.append(media);
  container.append(shell);
  const page = document.createElementNS(SVG_NAMESPACE, "svg");
  page.setAttribute("viewBox", `0 ${start} ${drawing.width} ${end - start}`);
  page.setAttribute("width", String(drawing.width));
  page.setAttribute("height", String(end - start));
  page.setAttribute("class", "inkbook-export-page");
  page.setAttribute("role", "img");
  page.setAttribute("aria-label", options.description?.trim() || "Handwriting");
  page.setAttribute("focusable", "false");
  page.setAttribute("preserveAspectRatio", "xMidYMin meet");
  media.append(page);
  if (options.deferGraphic !== true) activateExportPage(container, drawing);
  return container;
}

/** Activate references only after all dependent print geometry has been measured. */
export function activateExportPage(
  container: HTMLElement,
  drawing: ExportDrawing,
  referencePadding = 0,
): void {
  const page = container.querySelector<SVGSVGElement>(".inkbook-export-page");
  if (page === null) return;
  const start = Number(container.dataset.inkbookRangeStart);
  const end = Number(container.dataset.inkbookRangeEnd);
  const references =
    drawing.fragments === undefined || (start === 0 && end === drawing.height)
      ? [drawing.id]
      : exportFragmentReferences(
          drawing.fragments,
          start - referencePadding,
          end + referencePadding,
          drawing.id,
        );
  for (const id of references) {
    const reference = container.ownerDocument.createElementNS(SVG_NAMESPACE, "use");
    reference.setAttribute("href", `#${id}`);
    page.append(reference);
  }
}
