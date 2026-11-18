import { BoundedVersionLru } from "../../domain/cache/bounded-version-lru";
import { IMAGE_LIMITS } from "../../domain/images/image-limits";
import type { ImageRasterSize } from "../../domain/images/image-raster-size";
import {
  prepareRasterImage,
  rasterPreparationKey,
  type ImageRasterOptions,
  type PreparedRasterImage,
} from "./image-import";
import type { PdfImageResolution, PdfImageSource } from "./pdf-image-source";

export interface PreparedImportImage extends PreparedRasterImage {
  readonly resolution?: PdfImageResolution | undefined;
}

type ReviewRasterOptions = ImageRasterOptions & {
  readonly quality?: never;
  readonly maximumPixels: number;
};

const ENTRY_BYTES = 256;
const MAX_ENTRIES = IMAGE_LIMITS.pdfSelectedPages;
// Two bytes per Base64 character, including a separately padded final quartet per entry.
const MAX_BYTES = 8 * Math.ceil(IMAGE_LIMITS.documentBytes / 3) + MAX_ENTRIES * (ENTRY_BYTES + 8);

/** Owns only encoded previews and their metadata for one selected source. */
export class ImageImportPreparations {
  readonly #entries = new BoundedVersionLru<PreparedImportImage>(MAX_ENTRIES, MAX_BYTES);
  #sourceSize: ImageRasterSize | undefined;
  #version = 0;

  public async raster(
    source: Uint8Array<ArrayBuffer>,
    options: ReviewRasterOptions,
  ): Promise<PreparedImportImage> {
    const version = this.#version;
    if (this.#sourceSize !== undefined) {
      const key = rasterPreparationKey(this.#sourceSize, options.maximumPixels);
      const retained = this.#entries.get(key, version);
      if (retained !== undefined) return retained;
    }
    const prepared = await prepareRasterImage(source, options);
    options.signal.throwIfAborted();
    if (version === this.#version) {
      const { width, height } = prepared.resizedFrom ?? prepared.resource;
      this.#sourceSize = { width, height };
      this.#remember(
        rasterPreparationKey(this.#sourceSize, options.maximumPixels),
        prepared,
        false,
      );
    }
    return prepared;
  }

  public async pdf(
    source: PdfImageSource,
    page: number,
    options: ReviewRasterOptions & { readonly scale: number },
    inserting: boolean,
  ): Promise<PreparedImportImage> {
    const version = this.#version;
    const key = `${page}:${options.scale}:${options.maximumPixels}`;
    const retained = this.#entries.get(key, version);
    if (retained !== undefined) return retained;
    const resource = await source.render(page, options);
    options.signal.throwIfAborted();
    const prepared = { resource, resolution: source.resolution };
    if (version === this.#version) this.#remember(key, prepared, inserting);
    return prepared;
  }

  public clear(): void {
    this.#version++;
    this.#sourceSize = undefined;
    this.#entries.clear();
  }

  #remember(key: string, value: PreparedImportImage, inserting: boolean): void {
    const bytes = value.resource.data.length * 2 + ENTRY_BYTES;
    if (inserting) {
      // A miss during insertion must not evict a reviewed page needed later in this batch.
      const { entries, bytes: retainedBytes } = this.#entries.statistics();
      if (entries >= MAX_ENTRIES || retainedBytes + bytes > MAX_BYTES) return;
    }
    this.#entries.set(key, this.#version, value, bytes);
  }
}
