import type { ImageElementV3, ImageResourceV3 } from "../../../src/domain/schema/public";
import { sha256Hex } from "../../../src/persistence/serialization/sha256";
import { imageElement } from "../domain/images";

export function rasterResource(): ImageResourceV3 {
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=";
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  return { id: sha256Hex(bytes), mimeType: "image/png", width: 1, height: 1, data };
}

/** Bind an instance's full source crop to its actual immutable raster dimensions. */
export function rasterImage(
  resource: ImageResourceV3,
  overrides: Partial<ImageElementV3> = {},
): ImageElementV3 {
  return {
    ...imageElement(),
    assetId: resource.id,
    crop: { x: 0, y: 0, width: resource.width, height: resource.height },
    ...overrides,
  };
}
