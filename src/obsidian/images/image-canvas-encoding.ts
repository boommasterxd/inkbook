import type { ImageResourceV3 } from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { IMAGE_LIMITS } from "../../domain/images/image-limits";
import { createImageResource } from "../../persistence/images/image-resources";
import { ImageImportError } from "./image-import-error";

export interface ImageCanvasEncodingOptions {
  readonly scheduler: WorkScheduler;
  readonly signal: AbortSignal;
  readonly quality?: number;
}

/** At most two serial encodes; WebP must preserve pixels and beat the existing format. */
export async function encodeImageCanvas(
  canvas: HTMLCanvasElement,
  sourceMime: ImageResourceV3["mimeType"],
  options: ImageCanvasEncodingOptions,
): Promise<ImageResourceV3> {
  options.signal.throwIfAborted();
  const fallbackMime = sourceMime === "image/jpeg" ? "image/jpeg" : "image/png";
  const candidate = await webpCandidate(canvas);
  options.signal.throwIfAborted();
  const pending = options.scheduler.checkpoint(options.signal, "background");
  if (pending !== undefined) await pending;
  options.signal.throwIfAborted();
  const fallback =
    candidate?.type === "image/png" && fallbackMime === "image/png"
      ? candidate
      : await canvasBlob(canvas, fallbackMime, options.quality ?? 0.9);
  options.signal.throwIfAborted();
  if (
    candidate?.type === "image/webp" &&
    candidate.size < fallback.size &&
    candidate.size <= IMAGE_LIMITS.resourceBytes
  ) {
    try {
      const bytes = new Uint8Array(await candidate.arrayBuffer());
      options.signal.throwIfAborted();
      return await createImageResource(bytes, "image/webp", options.scheduler, options.signal, {
        requireLosslessWebp: true,
      });
    } catch {
      options.signal.throwIfAborted();
    }
  }
  if (fallback.size > IMAGE_LIMITS.resourceBytes)
    throw new ImageImportError("encodedSize", "Encoded image exceeds 8 MiB.");
  if (fallback.type !== "image/png" && fallback.type !== "image/jpeg")
    throw new Error("The native encoder returned an unsupported fallback format.");
  const bytes = new Uint8Array(await fallback.arrayBuffer());
  options.signal.throwIfAborted();
  return createImageResource(bytes, fallback.type, options.scheduler, options.signal);
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error("Image encoding failed.")) : resolve(blob)),
      type,
      quality,
    );
  });
}

async function webpCandidate(canvas: HTMLCanvasElement): Promise<Blob | undefined> {
  // The existing 16,384-pixel axis stays valid even where native WebP stops at 16,383.
  if (canvas.width > 16_383 || canvas.height > 16_383) return undefined;
  try {
    return await canvasBlob(canvas, "image/webp", 1);
  } catch {
    return undefined;
  }
}
