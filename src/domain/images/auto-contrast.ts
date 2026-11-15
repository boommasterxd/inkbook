import type { Bounds } from "../geometry/primitives";

/** Shared portable contrast program: choose black above linear luminance 0.179. */
export const AUTO_CONTRAST_MATRIX =
  "-0.8504 -2.8608 -0.2888 0 1.216 -0.8504 -2.8608 -0.2888 0 1.216 -0.8504 -2.8608 -0.2888 0 1.216 0 0 0 0 1";

/** Static SVG paint regions remain bounded independently of total document height. */
export const AUTO_CONTRAST_TILE_AXIS = 2048;

export const AUTO_CONTRAST_SHARED_TILE_AXIS = 64;
export const AUTO_CONTRAST_SHARED_TILE_STRIDE = 32;

/** Overlapping shared tiles contain every small region, including grid crossings. */
export function sharedAutoContrastBox(
  bounds: Readonly<Bounds>,
  minimumStride = AUTO_CONTRAST_SHARED_TILE_STRIDE,
): Bounds {
  const minX = Math.floor(bounds.minX * 1000) / 1000;
  const minY = Math.floor(bounds.minY * 1000) / 1000;
  const maxX = Math.ceil(bounds.maxX * 1000) / 1000;
  const maxY = Math.ceil(bounds.maxY * 1000) / 1000;
  const stride = minimumStride;
  if (maxX > minX + stride || maxY > minY + stride) return { minX, minY, maxX, maxY };
  const left = Math.floor(minX / stride) * stride;
  const top = Math.floor(minY / stride) * stride;
  const axis = AUTO_CONTRAST_SHARED_TILE_AXIS * (stride / AUTO_CONTRAST_SHARED_TILE_STRIDE);
  return {
    minX: left,
    minY: top,
    maxX: left + axis,
    maxY: top + axis,
  };
}
