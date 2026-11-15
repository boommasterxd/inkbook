import type { ImageResourceV3 } from "../../../src/domain/schema/public";
import { sha256Hex } from "../../../src/persistence/serialization/sha256";
import { serializeSvgEnvelope } from "../../../src/persistence/documents/svg-envelope";
import { serializeImageMarkup } from "../../../src/persistence/serialization/output/image-markup";
import { imageElement } from "../domain/images";
import { createWorkerSnapshot } from "./worker-snapshot";

export function rasterResource(): ImageResourceV3 {
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=";
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  return { id: sha256Hex(bytes), mimeType: "image/png", width: 1, height: 1, data };
}

export function rasterSvg(rotation = 0): string {
  const resource = rasterResource();
  const image = {
    ...imageElement(),
    rotation,
    assetId: resource.id,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  };
  return serializeSvgEnvelope(
    { ...createWorkerSnapshot([image]), version: 3, imageResources: [resource] },
    1000,
    {
      background: [],
      images: [serializeImageMarkup(image)],
      highlights: [],
      content: [],
    },
  );
}
