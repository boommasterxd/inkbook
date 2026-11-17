import { loadPdfJs } from "obsidian";
import type { ImageResourceV3 } from "../../domain/schema/public";
import { IMAGE_LIMITS } from "../../domain/images/image-limits";
import { fitImageRasterSize } from "../../domain/images/image-raster-size";
import { assertRasterDimensions, type ImageRasterOptions } from "./image-import";
import { encodeImageCanvas } from "./image-canvas-encoding";

interface PdfViewport {
  readonly width: number;
  readonly height: number;
}
interface PdfRenderTask {
  readonly promise: Promise<unknown>;
  cancel(): void;
}
interface PdfPage {
  getViewport(options: { readonly scale: number }): PdfViewport;
  render(options: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewport;
  }): PdfRenderTask;
  cleanup(): void;
}
interface PdfDocument {
  readonly numPages: number;
  getPage(page: number): Promise<unknown>;
}
interface PdfLoadingTask {
  readonly promise: Promise<unknown>;
  destroy(): Promise<unknown>;
}
interface PdfLibrary {
  getDocument(options: Record<string, unknown>): unknown;
}

export const PDF_THUMBNAIL_EDGE = 144;

/** The main page already holds decoded pixels when it can supply a thumbnail. */
export function copyPdfThumbnail(image: HTMLImageElement): HTMLCanvasElement | undefined {
  if (!image.complete || image.naturalWidth < 1 || image.naturalHeight < 1) return undefined;
  const scale = Math.min(1, PDF_THUMBNAIL_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = thumbnailCanvas(image.ownerDocument, {
    width: image.naturalWidth * scale,
    height: image.naturalHeight * scale,
  });
  try {
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("PDF thumbnail rasterization is unavailable.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch {
    canvas.width = 0;
    canvas.height = 0;
    return undefined;
  }
}

interface PdfThumbnailOptions {
  readonly document: Document;
  readonly signal: AbortSignal;
}

export interface PdfImageResolution {
  readonly page: number;
  readonly dpi: number;
  readonly limited: boolean;
}

/** One owned PDF document with foreground rasterization ahead of speculative thumbnails. */
export interface PdfImageSource {
  readonly pageCount: number;
  readonly resolution?: PdfImageResolution | undefined;
  render(
    page: number,
    options: ImageRasterOptions & { readonly scale?: number },
  ): Promise<ImageResourceV3>;
  renderThumbnail(page: number, options: PdfThumbnailOptions): Promise<HTMLCanvasElement>;
  dispose(): Promise<void>;
}

function objectWithMethods(
  value: unknown,
  methods: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    methods.every((method) => typeof Reflect.get(value, method) === "function")
  );
}

function promise(value: unknown): value is Promise<unknown> {
  return objectWithMethods(value, ["then"]);
}

/** PDF.js must never retrieve CMaps or font data from an external service. */
class LocalPdfDataOnly {
  public fetch(): Promise<never> {
    return Promise.reject(
      new Error("This PDF requires font or CMap data unavailable in the local host."),
    );
  }
}

export async function openPdfImageSource(
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<PdfImageSource> {
  if (
    bytes.length > IMAGE_LIMITS.sourceBytes ||
    String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-"
  )
    throw new RangeError("Invalid PDF source.");
  signal.throwIfAborted();
  const candidate: unknown = await loadPdfJs();
  signal.throwIfAborted();
  if (!objectWithMethods(candidate, ["getDocument"]))
    throw new Error("The host PDF renderer is unavailable.");
  const rawTask = (candidate as unknown as PdfLibrary).getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    stopAtErrors: true,
    CMapReaderFactory: LocalPdfDataOnly,
    StandardFontDataFactory: LocalPdfDataOnly,
  });
  if (!objectWithMethods(rawTask, ["destroy"]) || !promise(rawTask.promise))
    throw new Error("The host PDF loader is incompatible.");
  const task = rawTask as unknown as PdfLoadingTask;
  let disposed = false;
  let pages: PdfPagesRasterizer | undefined;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", abort);
    pages?.close();
    await task.destroy();
  };
  const abort = (): void => {
    void dispose().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const rawDocument = await task.promise;
    signal.throwIfAborted();
    if (
      !objectWithMethods(rawDocument, ["getPage"]) ||
      !Number.isInteger(rawDocument.numPages) ||
      Number(rawDocument.numPages) < 1 ||
      Number(rawDocument.numPages) > 10_000
    )
      throw new RangeError("PDF page capacity exceeded.");
    pages = new PdfPagesRasterizer(rawDocument as unknown as PdfDocument, dispose);
    return pages;
  } catch (error) {
    await dispose();
    throw error;
  }
}

class PdfPagesRasterizer implements PdfImageSource {
  readonly #lifetime = new AbortController();
  #busy = false;
  #resolution: PdfImageResolution | undefined;
  #thumbnail:
    { readonly abort: AbortController; readonly done: Promise<HTMLCanvasElement> } | undefined;

  public constructor(
    private readonly pdf: PdfDocument,
    public readonly dispose: () => Promise<void>,
  ) {}

  public get pageCount(): number {
    return this.pdf.numPages;
  }

  public get resolution(): PdfImageResolution | undefined {
    return this.#resolution;
  }

  public close(): void {
    this.#lifetime.abort();
  }

  public async render(
    number: number,
    options: ImageRasterOptions & { readonly scale?: number },
  ): Promise<ImageResourceV3> {
    options.signal.throwIfAborted();
    const thumbnail = this.#thumbnail;
    if (thumbnail !== undefined) {
      thumbnail.abort.abort();
      await thumbnail.done.catch(() => undefined);
    }
    return this.#withPage(number, options.signal, async (page, signal) => {
      const prepared = await rasterizePdfPage(page, { ...options, signal });
      this.#resolution = { page: number, dpi: prepared.dpi, limited: prepared.limited };
      return prepared.resource;
    });
  }

  public async renderThumbnail(
    number: number,
    options: PdfThumbnailOptions,
  ): Promise<HTMLCanvasElement> {
    const abort = new AbortController();
    const done = this.#withPage(
      number,
      AbortSignal.any([options.signal, abort.signal]),
      (page, signal) => rasterizePdfThumbnail(page, { ...options, signal }),
    );
    if (this.#thumbnail !== undefined) return done;
    this.#thumbnail = { abort, done };
    try {
      return await done;
    } finally {
      this.#thumbnail = undefined;
    }
  }

  async #withPage<T>(
    number: number,
    signal: AbortSignal,
    work: (page: PdfPage, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const lifetime = AbortSignal.any([signal, this.#lifetime.signal]);
    lifetime.throwIfAborted();
    if (this.#busy) throw new Error("PDF source is busy.");
    if (!Number.isInteger(number) || number < 1 || number > this.pageCount)
      throw new RangeError("Invalid PDF page.");
    this.#busy = true;
    let page: PdfPage | undefined;
    try {
      const rawPage = await this.pdf.getPage(number);
      if (!objectWithMethods(rawPage, ["getViewport", "render", "cleanup"]))
        throw new Error("The host PDF page is incompatible.");
      page = rawPage as unknown as PdfPage;
      lifetime.throwIfAborted();
      return await work(page, lifetime);
    } finally {
      this.#busy = false;
      page?.cleanup();
    }
  }
}

async function rasterizePdfPage(
  page: PdfPage,
  options: ImageRasterOptions & { readonly scale?: number },
): Promise<{
  readonly resource: ImageResourceV3;
  readonly dpi: number;
  readonly limited: boolean;
}> {
  const unit = unitViewport(page);
  const requestedScale = options.scale ?? 2;
  const { scale } = fitImageRasterSize(
    unit.width,
    unit.height,
    requestedScale,
    options.maximumPixels,
  );
  const viewport = page.getViewport({ scale });
  const canvas = options.document.createElement("canvas");
  try {
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    assertRasterDimensions(canvas.width, canvas.height);
    await paintPdfCanvas(page, canvas, viewport, options.signal);
    const resource = await encodeImageCanvas(canvas, "image/png", options);
    return { resource, dpi: 72 * scale, limited: scale + 1e-9 < requestedScale };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function rasterizePdfThumbnail(
  page: PdfPage,
  options: PdfThumbnailOptions,
): Promise<HTMLCanvasElement> {
  const unit = unitViewport(page);
  const scale = PDF_THUMBNAIL_EDGE / Math.max(unit.width, unit.height);
  const viewport = page.getViewport({ scale });
  const canvas = thumbnailCanvas(options.document, viewport);
  try {
    await paintPdfCanvas(page, canvas, viewport, options.signal);
    return canvas;
  } catch (error) {
    canvas.width = 0;
    canvas.height = 0;
    throw error;
  }
}

function thumbnailCanvas(document: Document, viewport: PdfViewport): HTMLCanvasElement {
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  assertRasterDimensions(width, height, PDF_THUMBNAIL_EDGE ** 2);
  if (Math.max(width, height) > PDF_THUMBNAIL_EDGE)
    throw new RangeError("Invalid PDF thumbnail dimensions.");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function unitViewport(page: PdfPage): PdfViewport {
  const unit = page.getViewport({ scale: 1 });
  if (
    !Number.isFinite(unit.width) ||
    !Number.isFinite(unit.height) ||
    unit.width <= 0 ||
    unit.height <= 0
  )
    throw new RangeError("Invalid PDF page dimensions.");
  return unit;
}

async function paintPdfCanvas(
  page: PdfPage,
  canvas: HTMLCanvasElement,
  viewport: PdfViewport,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("PDF rasterization is unavailable.");
  const rawTask: unknown = page.render({ canvas, canvasContext: context, viewport });
  if (!objectWithMethods(rawTask, ["cancel"]) || !promise(rawTask.promise))
    throw new Error("The host PDF render task is incompatible.");
  const task = rawTask as unknown as PdfRenderTask;
  const abort = (): void => task.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    await task.promise;
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
