import { chooseExportCut, type PreparedExportCuts } from "../../../domain/export/export-pagination";
import { applyResponsiveLockedEmbedShell } from "../presentation/locked-embed-shell";
import {
  activateExportPage,
  createExportPage,
  type ExportDrawing,
  type ExportPageOptions,
} from "./export-pages";
import { pageContaining, readPrintPages, type PrintPage } from "./print-layout";

const MAX_PRINT_PIECES = 256;
const PIECE_GAP = 12;
const MAX_UNUSED_SHARE = 0.16;
const MINIMUM_PIECE = 64;
const REFERENCE_OVERSCAN = 2;

export interface PaginatedExport {
  readonly container: HTMLElement;
  readonly drawing: ExportDrawing;
  readonly cuts: PreparedExportCuts;
  readonly options: ExportPageOptions;
}

interface OwnedExport extends PaginatedExport {
  referencePadding: number;
  readonly children: readonly Node[];
  readonly graphics: readonly { readonly svg: SVGSVGElement; readonly children: readonly Node[] }[];
}

interface PrintSlice {
  readonly start: number;
  readonly end: number;
  readonly newPage: boolean;
}

/** Only the temporary print document owns this listener and its prepared cut data. */
export class StaticExportPagination {
  readonly #root: HTMLElement;
  readonly #exports: OwnedExport[] = [];
  #media: MediaQueryList | undefined;
  #publishedPieces = 0;
  #budgetExhausted = false;

  constructor(root: HTMLElement) {
    this.#root = root;
  }

  register(output: PaginatedExport): void {
    this.#exports.push({
      ...output,
      referencePadding: 0,
      children: Array.from(output.container.childNodes),
      graphics: Array.from(
        output.container.querySelectorAll<SVGSVGElement>(".inkbook-export-page"),
        (svg) => ({ svg, children: Array.from(svg.childNodes) }),
      ),
    });
  }

  start(): void {
    const ownerWindow = this.#root.ownerDocument.defaultView;
    if (ownerWindow === null || this.#exports.length === 0) return;
    this.#media = ownerWindow.matchMedia("print");
    this.#media.addEventListener("change", this.#onPrintChange);
    ownerWindow.addEventListener("afterprint", this.#restore);
    if (this.#media.matches) this.#paginate();
  }

  dispose(): void {
    this.#media?.removeEventListener("change", this.#onPrintChange);
    this.#root.ownerDocument.defaultView?.removeEventListener("afterprint", this.#restore);
    this.#restore();
    this.#exports.length = 0;
  }

  readonly #onPrintChange = (event: MediaQueryListEvent): void => {
    if (event.matches) this.#paginate();
    else this.#restore();
  };

  readonly #restore = (): void => {
    for (const output of this.#exports) this.#restoreOutput(output);
    this.#publishedPieces = 0;
    this.#budgetExhausted = false;
  };

  #restoreOutput(output: OwnedExport, graphics = true): void {
    const container = output.container;
    if (container.classList.contains("inkbook-export-fragmented"))
      container.replaceChildren(...output.children);
    container.classList.remove("inkbook-export-fragmented", "inkbook-export-keep");
    delete container.dataset.inkbookPagination;
    output.referencePadding = 0;
    if (graphics) this.#restoreGraphics(output);
  }

  #restoreGraphics(output: OwnedExport): void {
    for (const { svg, children } of output.graphics)
      if (svg.firstChild !== children[0]) svg.replaceChildren(...children);
  }

  #paginate(): void {
    this.#restore();
    // Keep the final box model while removing expensive SVG instances from layout reads.
    for (const output of this.#exports)
      for (const { svg } of output.graphics) svg.replaceChildren();
    let pages: readonly PrintPage[] | undefined;
    for (const output of this.#exports) {
      if (this.#budgetExhausted || this.#publishedPieces >= MAX_PRINT_PIECES) break;
      if (!this.#root.contains(output.container)) continue;
      try {
        pages ??= readPrintPages(this.#root);
        this.#paginateOutput(output, pages);
        if (output.container.dataset.inkbookPagination !== undefined) pages = undefined;
      } catch {
        this.#restoreOutput(output, false);
        output.container.dataset.inkbookPagination = "fallback";
      }
    }
    for (const output of this.#exports) {
      if (output.container.dataset.inkbookPagination === "split") {
        for (const piece of output.container.querySelectorAll<HTMLElement>(".inkbook-export-piece"))
          activateExportPage(piece, output.drawing, output.referencePadding);
      } else this.#restoreGraphics(output);
    }
  }

  #paginateOutput(output: OwnedExport, pages: readonly PrintPage[]): void {
    const rect = output.container.getBoundingClientRect();
    const firstPage = pageContaining(pages, rect.top);
    if (firstPage === undefined || rect.bottom <= firstPage.bottom - 1) return;
    const remaining = firstPage.bottom - rect.top;
    const pageHeight = firstPage.height;
    if (rect.height <= pageHeight - PIECE_GAP && remaining <= pageHeight * MAX_UNUSED_SHARE) {
      output.container.classList.add("inkbook-export-keep");
      output.container.dataset.inkbookPagination = "keep";
      return;
    }
    const media = output.container.querySelector<HTMLElement>(".inkbook-export-pages");
    if (media === null) return;
    const scale = media.getBoundingClientRect().width / output.drawing.width;
    const radius = Number.parseFloat(
      output.container.ownerDocument.defaultView!.getComputedStyle(output.container, "::before")
        .borderTopLeftRadius,
    );
    if (!(scale > 0) || !Number.isFinite(radius)) return;
    const slices = planSlices(output, {
      remaining,
      pageHeight,
      scale,
      radius,
      maximumPieces: MAX_PRINT_PIECES - this.#publishedPieces,
    });
    if (slices === undefined) {
      this.#budgetExhausted = true;
      return;
    }
    if (slices.length === 0) return;
    // Keep antialiased paint just outside the viewBox in the reference set; clipping is unchanged.
    output.referencePadding = REFERENCE_OVERSCAN / scale;
    this.#publish(output, slices);
    this.#publishedPieces += slices.length;
  }

  #publish(output: OwnedExport, slices: readonly PrintSlice[]): void {
    const container = output.container;
    const definitions = output.children.filter(
      (node) =>
        node.nodeType === 1 && (node as Element).classList.contains("inkbook-export-definitions"),
    );
    const pieces = slices.map((slice) => {
      const piece = createExportPage(container.ownerDocument, output.drawing, {
        ...output.options,
        start: slice.start,
        end: slice.end,
        deferGraphic: true,
      });
      piece.classList.add("inkbook-export-piece");
      if (slice.newPage) piece.classList.add("inkbook-export-continued");
      applyResponsiveLockedEmbedShell(piece);
      return piece;
    });
    container.classList.add("inkbook-export-fragmented");
    container.dataset.inkbookPagination = "split";
    container.replaceChildren(...definitions, ...pieces);
  }
}

function planSlices(
  output: PaginatedExport,
  layout: {
    readonly remaining: number;
    readonly pageHeight: number;
    readonly scale: number;
    readonly radius: number;
    readonly maximumPieces: number;
  },
): readonly PrintSlice[] | undefined {
  const { pageHeight, scale, radius } = layout;
  const chrome = radius * 2 + 2;
  const slices: PrintSlice[] = [];
  let start = 0;
  let room = layout.remaining;
  let newPage = false;
  if (room < Math.max(MINIMUM_PIECE, chrome + 24)) {
    room = pageHeight - PIECE_GAP;
    newPage = true;
  }
  while (start < output.drawing.height) {
    if (slices.length >= layout.maximumPieces) return undefined;
    const limit = Math.min(output.drawing.height, start + (room - chrome - 1) / scale);
    if (!(limit > start)) return [];
    const end =
      limit === output.drawing.height
        ? limit
        : chooseExportCut(output.cuts, {
            start,
            limit,
            minimum: Math.min(MINIMUM_PIECE / scale, limit - start),
            lookback: Math.min(pageHeight * MAX_UNUSED_SHARE, room * 0.3) / scale,
            clearance: 1 / scale,
          });
    slices.push({ start, end, newPage });
    start = end;
    room = pageHeight - PIECE_GAP;
    newPage = true;
  }
  return slices;
}
