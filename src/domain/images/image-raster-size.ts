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
): ImageRasterSize & { readonly scale: number } {
  const scale = Math.min(
    requestedScale,
    Math.sqrt(IMAGE_LIMITS.resourcePixels / (width * height)),
    IMAGE_LIMITS.resourceAxis / width,
    IMAGE_LIMITS.resourceAxis / height,
  );
  return { width: Math.floor(width * scale), height: Math.floor(height * scale), scale };
}
