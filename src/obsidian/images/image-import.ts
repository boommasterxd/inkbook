import { IMAGE_LIMITS } from "../../domain/images/image-limits";
import { fitImageRasterSize, type ImageRasterSize } from "../../domain/images/image-raster-size";
import type { ImageResourceV3 } from "../../domain/schema/public";
import { inspectImageHeaderSteps, type ImageHeader } from "../../persistence/images/image-header";
import { ImageImportError } from "./image-import-error";
import { encodeImageCanvas, type ImageCanvasEncodingOptions } from "./image-canvas-encoding";

export interface ImageRasterOptions extends ImageCanvasEncodingOptions {
  readonly document: Document;
}

export interface PreparedRasterImage {
  readonly resource: ImageResourceV3;
  readonly resizedFrom?: ImageRasterSize;
}

export async function readImageSource(
  file: File,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();
  if (file.size === 0) throw new ImageImportError("sourceRead", "Image source is empty.");
  if (file.size > IMAGE_LIMITS.sourceBytes)
    throw new ImageImportError("sourceSize", "Image source exceeds the 16 MiB capacity.");
  const bytes = new Uint8Array(
    await file.arrayBuffer().catch(() => {
      throw new ImageImportError("sourceRead", "Image source could not be read.");
    }),
  );
  signal.throwIfAborted();
  if (bytes.length !== file.size)
    throw new ImageImportError("sourceRead", "Image source changed during reading.");
  return bytes;
}

/** Removes metadata and normalizes JPEG orientation once before creating a portable resource. */
export async function prepareRasterImage(
  bytes: Uint8Array<ArrayBuffer>,
  options: ImageRasterOptions,
): Promise<PreparedRasterImage> {
  const header = await inspectSourceHeader(bytes, options);
  options.signal.throwIfAborted();
  const ownerWindow = options.document.defaultView;
  if (ownerWindow === null) throw new Error("Image import requires an owning window.");
  const bitmap = await ownerWindow
    .createImageBitmap(new Blob([bytes], { type: header.mimeType }), {
      imageOrientation: "from-image",
    })
    .catch(() => {
      throw new ImageImportError("decode", "Image decoding failed.");
    });
  const canvas = options.document.createElement("canvas");
  const sourceSize = { width: bitmap.width, height: bitmap.height };
  let bitmapReleased = false;
  try {
    options.signal.throwIfAborted();
    assertRasterDimensions(bitmap.width, bitmap.height, IMAGE_LIMITS.sourcePixels);
    const size = fitImageRasterSize(bitmap.width, bitmap.height);
    assertRasterDimensions(size.width, size.height);
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Image rasterization is unavailable.");
    const resized = size.width !== bitmap.width || size.height !== bitmap.height;
    if (resized) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
    }
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    bitmapReleased = true;
    const resource = await encodeImageCanvas(canvas, header.mimeType, options);
    return resized ? { resource, resizedFrom: sourceSize } : { resource };
  } finally {
    if (!bitmapReleased) bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function inspectSourceHeader(
  bytes: Uint8Array,
  options: ImageRasterOptions,
): Promise<ImageHeader> {
  const steps = inspectImageHeaderSteps(bytes, { source: true });
  let step = steps.next();
  while (!step.done) {
    options.signal.throwIfAborted();
    const pending = options.scheduler.checkpoint(options.signal, "background");
    if (pending !== undefined) await pending;
    step = steps.next();
  }
  return step.value;
}

export function assertRasterDimensions(
  width: number,
  height: number,
  maximumPixels: number = IMAGE_LIMITS.resourcePixels,
): void {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    width > IMAGE_LIMITS.resourceAxis ||
    height > IMAGE_LIMITS.resourceAxis ||
    width * height > maximumPixels
  )
    throw new ImageImportError("dimensions", "Raster dimensions exceed the configured capacity.");
}

/** Selection is explicit, bounded and normalized into predictable document order. */
export function parsePdfPages(value: string, pageCount: number): readonly number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 10_000 || value.length > 256)
    throw new ImageImportError("pdfPages", "Invalid PDF page selection.");
  const pages = new Set<number>();
  for (const token of value.split(",")) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token.trim());
    if (match === null) throw new ImageImportError("pdfPages", "Enter PDF pages such as 1, 3-5.");
    const start = Number(match[1]);
    const end = Number(match[2] ?? start);
    if (start < 1 || end < start || end > pageCount || end - start >= IMAGE_LIMITS.pdfSelectedPages)
      throw new ImageImportError("pdfPages", "Invalid PDF page selection.");
    for (let page = start; page <= end; page += 1) {
      pages.add(page);
      if (pages.size > IMAGE_LIMITS.pdfSelectedPages)
        throw new ImageImportError("pdfPages", "Select at most 20 PDF pages.");
    }
  }
  return [...pages].sort((left, right) => left - right);
}
