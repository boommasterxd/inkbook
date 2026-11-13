import { PORTABLE_PALETTE_V1 } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { appendParsedPreviewElement, createPreviewSvgAsync } from "../preview/safe-preview-builder";
import { configurePreviewSvg, type LoadedPreviewSvg } from "../preview/safe-preview-svg";
import type { InkbookColorScheme } from "../../theme/color-scheme";
import {
  prepareStaticExportFragments,
  type StaticExportFragment,
} from "../../../persistence/export/static-export-fragments";

interface StaticExportSvgOptions {
  readonly workScheduler: WorkScheduler;
  readonly signal: AbortSignal;
  readonly description?: string;
  readonly colorScheme?: InkbookColorScheme;
}

export interface PreparedStaticExportSvg {
  readonly svg: SVGSVGElement;
  readonly fragments: readonly StaticExportFragment[];
}

/** Scans canonical safe markup once for detached DOM and actual static fragment bounds. */
export async function createPreparedStaticExportSvg(
  ownerDocument: Document,
  descriptor: LoadedPreviewSvg,
  options: StaticExportSvgOptions,
): Promise<PreparedStaticExportSvg | undefined> {
  if (options.signal.aborted) return undefined;
  const parents: Element[] = [];
  let svg: SVGSVGElement | undefined;
  try {
    const fragments = await prepareStaticExportFragments(descriptor.safeSvg, {
      workScheduler: options.workScheduler,
      signal: options.signal,
      visitor: {
        open: (tag) => {
          const element = appendParsedPreviewElement(ownerDocument, tag, parents, (created) =>
            configureExportElement(created, options.colorScheme ?? "light"),
          );
          svg ??= element as SVGSVGElement;
        },
        close: () => {
          parents.pop();
        },
        text: (value) => {
          parents[parents.length - 1]?.append(ownerDocument.createTextNode(value));
        },
      },
    });
    if (fragments === undefined || svg === undefined || options.signal.aborted) return undefined;
    configurePreviewSvg(svg);
    configureExportRoot(svg, options.description);
    return { svg, fragments };
  } catch (error) {
    if (options.signal.aborted) return undefined;
    throw error;
  }
}

/** Builds a detached, complete export graphic from an already validated preview. */
export async function createStaticExportSvg(
  ownerDocument: Document,
  descriptor: LoadedPreviewSvg,
  options: StaticExportSvgOptions,
): Promise<SVGSVGElement | undefined> {
  if (options.signal.aborted) return undefined;
  let svg: SVGSVGElement | undefined;
  try {
    svg = await createPreviewSvgAsync(ownerDocument, descriptor.safeSvg, {
      checkpoint: () => options.workScheduler.checkpoint(options.signal, "background"),
      isCancelled: () => options.signal.aborted,
      workScheduler: options.workScheduler,
      configureElement: (element) =>
        configureExportElement(element, options.colorScheme ?? "light"),
    });
  } catch (error) {
    if (options.signal.aborted) return undefined;
    throw error;
  }
  if (svg === undefined || options.signal.aborted) return undefined;
  configureExportRoot(svg, options.description);
  return svg;
}

function configureExportRoot(svg: SVGSVGElement, description?: string): void {
  svg.removeAttribute("class");
  svg.removeAttribute("aria-hidden");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", description?.trim() || "Handwriting");
  svg.setAttribute("focusable", "false");
}

function configureExportElement(element: Element, scheme: InkbookColorScheme): void {
  if (element.localName === "style") return;
  const palette = PORTABLE_PALETTE_V1[scheme];
  switch (element.getAttribute("class")) {
    case "inkbook-theme-page":
      element.setAttribute("fill", palette.page);
      break;
    case "inkbook-theme-guide":
      element.setAttribute("stroke", palette.guide);
      element.setAttribute("vector-effect", "non-scaling-stroke");
      break;
    case "inkbook-theme-stroke":
      element.setAttribute("stroke", palette.text);
      break;
    case "inkbook-theme-fill":
      element.setAttribute("fill", palette.text);
      break;
    case "inkbook-theme-stroke-fill":
      element.setAttribute("fill", palette.text);
      element.setAttribute("stroke", palette.text);
      break;
  }
  element.removeAttribute("class");
  element.removeAttribute("id");
}
