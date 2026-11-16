import { IMAGE_LIMITS } from "../../domain/images/image-limits";
import type { ImageResourceV3 } from "../../domain/schema/public";
import { ImageImportError } from "./image-import-error";

/** Keeps page placements ordered while admitting each distinct raster only once. */
export class ImageImportStaging {
  readonly #unique = new Map<string, ImageResourceV3>();
  readonly #resources: ImageResourceV3[] = [];
  #bytes = 0;
  #pixels = 0;

  public get resources(): readonly ImageResourceV3[] {
    return this.#resources;
  }

  public add(resource: ImageResourceV3): void {
    const retained = this.#unique.get(resource.id);
    if (retained === undefined) {
      const padding = resource.data.endsWith("==") ? 2 : resource.data.endsWith("=") ? 1 : 0;
      const bytes = this.#bytes + (resource.data.length / 4) * 3 - padding;
      const pixels = this.#pixels + resource.width * resource.height;
      if (bytes > IMAGE_LIMITS.documentBytes || pixels > IMAGE_LIMITS.documentPixels)
        throw new ImageImportError("documentCapacity", "Image document capacity exceeded.");
      this.#bytes = bytes;
      this.#pixels = pixels;
      this.#unique.set(resource.id, resource);
    }
    this.#resources.push(retained ?? resource);
  }
}
