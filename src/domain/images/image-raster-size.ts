import { IMAGE_LIMITS } from "./image-limits";

export interface ImageRasterSize {
  readonly width: number;
  readonly height: number;
}

/** Shared pixel and axis admission for raster imports and native PDF-page rendering. */
export function fitImageRasterSize(
  width: number,
  height: number,
  requestedScale = 1,
  maximumPixels: number = IMAGE_LIMITS.defaultRasterPixels,
): ImageRasterSize & { readonly scale: number } {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(requestedScale) ||
    requestedScale <= 0 ||
    !Number.isSafeInteger(maximumPixels) ||
    maximumPixels < 1
  )
    throw new RangeError("Invalid raster size or resolution budget.");
  const scale = Math.min(
    requestedScale,
    Math.sqrt(Math.min(maximumPixels, IMAGE_LIMITS.resourcePixels) / (width * height)),
    IMAGE_LIMITS.resourceAxis / width,
    IMAGE_LIMITS.resourceAxis / height,
  );
  return { width: Math.floor(width * scale), height: Math.floor(height * scale), scale };
}
