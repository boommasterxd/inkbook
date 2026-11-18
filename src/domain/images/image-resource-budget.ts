import type { ImageResourceV3 } from "../schema/types";
import { IMAGE_LIMITS } from "./image-limits";

/** Accounts for each content-addressed image once without decoding or retaining its data. */
export class ImageResourceBudget {
  readonly #ids = new Set<string>();
  #bytes = 0;
  #pixels = 0;

  public tryInclude(resource: ImageResourceV3): boolean {
    if (this.#ids.has(resource.id)) return true;
    const padding = resource.data.endsWith("==") ? 2 : resource.data.endsWith("=") ? 1 : 0;
    const bytes = this.#bytes + (resource.data.length / 4) * 3 - padding;
    const pixels = this.#pixels + resource.width * resource.height;
    if (
      bytes > IMAGE_LIMITS.documentBytes ||
      pixels > IMAGE_LIMITS.documentPixels ||
      this.#ids.size >= IMAGE_LIMITS.resources
    )
      return false;
    this.#bytes = bytes;
    this.#pixels = pixels;
    this.#ids.add(resource.id);
    return true;
  }
}
