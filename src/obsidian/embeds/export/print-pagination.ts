import { chooseExportCut, type PreparedExportCuts } from "../../../domain/export/export-pagination";
import { applyResponsiveLockedEmbedShell } from "../presentation/locked-embed-shell";
import {
  activateExportPage,
  createExportPage,
  type ExportDrawing,
  type ExportPageOptions,
} from "./export-pages";
import {
  prepareNativePdfRoot,
  supportedNativePdfRoot,
  pageContaining,
  readPrintPages,
  type PrintPage,
} from "./print-layout";
import type { NativePdfOptions } from "./native-pdf-options";

const MAX_PRINT_PIECES = 256;
const PIECE_GAP = 12;
const MAX_UNUSED_SHARE = 0.16;
const MINIMUM_PIECE = 64;
const REFERENCE_OVERSCAN = 2;

export interface PaginatedExport {
  readonly host?: HTMLElement;
  readonly container: HTMLElement;
  readonly drawing: ExportDrawing;
  readonly cuts: PreparedExportCuts | undefined;
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
  #restoreRoot: (() => void) | undefined;

  constructor(
    root: HTMLElement,
    private readonly nativeOptions?: NativePdfOptions,
  ) {
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
    ownerWindow.addEventListener("beforeprint", this.#armNativeRoot);
    this.#armNativeRoot();
    if (this.#media.matches) this.#paginate();
  }

  dispose(): void {
    this.#media?.removeEventListener("change", this.#onPrintChange);
    this.#root.ownerDocument.defaultView?.removeEventListener("afterprint", this.#restore);
    this.#root.ownerDocument.defaultView?.removeEventListener("beforeprint", this.#armNativeRoot);
    this.#restore();
    this.#exports.length = 0;
  }

  readonly #onPrintChange = (event: MediaQueryListEvent): void => {
    if (event.matches) this.#paginate();
    else this.#restore();
  };

  readonly #restore = (): void => {
    this.#restoreOutputs();
    this.#restoreRoot?.();
    this.#restoreRoot = undefined;
  };

  readonly #armNativeRoot = (): void => {
    if (this.#restoreRoot !== undefined || this.nativeOptions === undefined) return;
    try {
      this.#restoreRoot = prepareNativePdfRoot(this.#root, this.nativeOptions.scale);
    } catch {
      this.#restoreRoot = undefined;
    }
  };

  #nativeRootReady(): boolean {
    if (this.nativeOptions === undefined || this.nativeOptions.scale >= 1) return true;
    try {
      return this.#restoreRoot !== undefined && supportedNativePdfRoot(this.#root);
    } catch {
      return false;
    }
  }

  #restoreOutputs(): void {
    for (const output of this.#exports) this.#restoreOutput(output);
    this.#publishedPieces = 0;
    this.#budgetExhausted = false;
  }

  #restoreOutput(output: OwnedExport, graphics = true): void {
    const container = output.container;
    output.host?.classList.remove("inkbook-export-page-start");
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
    this.#restoreOutputs();
    // Keep the final box model while removing expensive SVG instances from layout reads.
    for (const output of this.#exports)
      for (const { svg } of output.graphics) svg.replaceChildren();
    if (!this.#nativeRootReady()) {
      this.#restoreOutputs();
      return;
    }
    let pages: readonly PrintPage[] | undefined;
    let initialPages: readonly PrintPage[] | undefined;
    let layoutChanged = false;
    for (const output of this.#exports) {
      if (this.#budgetExhausted || this.#publishedPieces >= MAX_PRINT_PIECES) break;
      if (!this.#root.contains(output.container)) continue;
      if (output.cuts === undefined) continue;
      try {
        pages ??= readPrintPages(this.#root);
        initialPages ??= pages;
        this.#paginateOutput(output, pages);
        const state = output.container.dataset.inkbookPagination;
        if (state !== undefined) pages = undefined;
        layoutChanged ||= state === "keep" || state === "split";
      } catch {
        this.#restoreOutput(output, false);
        output.container.dataset.inkbookPagination = "fallback";
      }
    }
    if (layoutChanged && !this.#nativeOverflowSafe(initialPages)) {
      this.#restoreOutputs();
      return;
    }
    for (const output of this.#exports) {
      if (output.container.dataset.inkbookPagination === "split") {
        for (const piece of output.container.querySelectorAll<HTMLElement>(".inkbook-export-piece"))
          activateExportPage(piece, output.drawing, output.referencePadding);
      } else this.#restoreGraphics(output);
    }
  }

  #nativeOverflowSafe(initialPages: readonly PrintPage[] | undefined): boolean {
    if (this.nativeOptions === undefined) return true;
    try {
      if (initialPages === undefined || initialPages.length < 2) return false;
      const currentPageCount = this.#root.getClientRects().length;
      if (currentPageCount < 2) return false;
      if (currentPageCount <= initialPages.length) return true;
      const fullHeight = initialPages[0]!.height;
      for (let index = 0; index < initialPages.length - 1; index += 1) {
        if (initialPages[index]!.height !== fullHeight) return false;
      }
      const tail = initialPages[initialPages.length - 1]!;
      if (tail.height > fullHeight) return false;
      // Chromium may retain the original page count after a print-media layout change.
      // Extra root fragments are safe only when the last content still fits that capacity.
      const end = this.#root.lastElementChild?.getBoundingClientRect();
      return (
        end !== undefined &&
        [end.top, end.bottom, end.height, end.width].every(Number.isFinite) &&
        end.height > 0 &&
        end.width > 0 &&
        end.top >= initialPages[0]!.top &&
        end.bottom <= tail.top + fullHeight
      );
    } catch {
      return false;
    }
  }

  #paginateOutput(output: OwnedExport, pages: readonly PrintPage[]): void {
    if (output.cuts === undefined) return;
    const rect = output.container.getBoundingClientRect();
    const firstPage = pageContaining(pages, rect.top);
    if (firstPage === undefined || rect.bottom <= firstPage.bottom - 1) return;
    const remaining = firstPage.bottom - rect.top;
    const pageHeight = firstPage.height;
    if (rect.height <= pageHeight && remaining <= pageHeight * MAX_UNUSED_SHARE) {
      const host = output.host;
      const hostMargin =
        host === undefined
          ? 0
          : Number.parseFloat(
              host.ownerDocument.defaultView?.getComputedStyle(host).marginBlockStart ?? "0",
            );
      if (hostMargin > 0 && rect.height + hostMargin > pageHeight)
        host?.classList.add("inkbook-export-page-start");
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
    const slices = planSlices(
      { ...output, cuts: output.cuts },
      {
        remaining,
        pageHeight,
        scale,
        radius,
        maximumPieces: MAX_PRINT_PIECES - this.#publishedPieces,
      },
    );
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
      if (output.options.width !== undefined)
        piece.style.setProperty("--inkbook-embed-inline-size", "100%");
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
  output: PaginatedExport & { readonly cuts: PreparedExportCuts },
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
