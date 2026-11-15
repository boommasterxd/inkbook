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

/** A single owned PDF loading task. Rendering is serialized by the caller. */
export interface PdfImageSource {
  readonly pageCount: number;
  render(
    page: number,
    options: ImageRasterOptions & { readonly scale?: number },
  ): Promise<ImageResourceV3>;
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
  let rendering: PdfRenderTask | undefined;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", abort);
    rendering?.cancel();
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
    const document = rawDocument as unknown as PdfDocument;
    return {
      pageCount: document.numPages,
      dispose,
      render: async (number, options) => {
        if (disposed || rendering !== undefined)
          throw new Error("PDF source is unavailable or busy.");
        if (!Number.isInteger(number) || number < 1 || number > document.numPages)
          throw new RangeError("Invalid PDF page.");
        const rawPage = await document.getPage(number);
        if (!objectWithMethods(rawPage, ["getViewport", "render", "cleanup"]))
          throw new Error("The host PDF page is incompatible.");
        const page = rawPage as unknown as PdfPage;
        try {
          return await rasterizePdfPage(
            page,
            options,
            (active) => {
              rendering = active;
            },
            () => disposed,
          );
        } finally {
          rendering = undefined;
          page.cleanup();
        }
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function rasterizePdfPage(
  page: PdfPage,
  options: ImageRasterOptions & { readonly scale?: number },
  active: (task: PdfRenderTask | undefined) => void,
  disposed: () => boolean,
): Promise<ImageResourceV3> {
  options.signal.throwIfAborted();
  if (disposed()) throw new Error("PDF source is closed.");
  const unit = page.getViewport({ scale: 1 });
  if (
    !Number.isFinite(unit.width) ||
    !Number.isFinite(unit.height) ||
    unit.width <= 0 ||
    unit.height <= 0
  )
    throw new RangeError("Invalid PDF page dimensions.");
  const { scale } = fitImageRasterSize(unit.width, unit.height, options.scale ?? 2);
  const viewport = page.getViewport({ scale });
  const canvas = options.document.createElement("canvas");
  let task: PdfRenderTask | undefined;
  const abort = (): void => task?.cancel();
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    assertRasterDimensions(canvas.width, canvas.height);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("PDF rasterization is unavailable.");
    const rawTask: unknown = page.render({ canvas, canvasContext: context, viewport });
    if (!objectWithMethods(rawTask, ["cancel"]) || !promise(rawTask.promise))
      throw new Error("The host PDF render task is incompatible.");
    task = rawTask as unknown as PdfRenderTask;
    active(task);
    await task.promise;
    options.signal.throwIfAborted();
    return await encodeImageCanvas(canvas, "image/png", options);
  } finally {
    options.signal.removeEventListener("abort", abort);
    active(undefined);
    canvas.width = 0;
    canvas.height = 0;
  }
}
