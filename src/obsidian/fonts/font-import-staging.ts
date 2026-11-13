import type { FontResourceV2 } from "../../domain/schema/types";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { FONT_LIMITS } from "../../persistence/fonts/font-container";
import { readImportedFontMetadata } from "../../persistence/fonts/font-metadata";
import { createFontResource, type FontDescriptor } from "../../persistence/fonts/font-resources";

export type FontImportErrorCode =
  | "invalid-font"
  | "native-rejected"
  | "file-limit"
  | "staging-limit"
  | "library-full"
  | "unavailable-family"
  | "duplicate-family"
  | "invalid-name"
  | "invalid-prepared";

export class FontImportError extends Error {
  public readonly cause: unknown;

  public constructor(
    public readonly code: FontImportErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.cause = options?.cause;
  }
}

export interface PreparedLibraryFontFace {
  readonly id: string;
  readonly fileName: string;
  readonly familyName: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  readonly weightRange?: readonly [number, number];
  readonly resource: FontResourceV2;
}

interface PreparedFontData {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly ownedBytes: number;
}

interface FontPreparationOptions {
  readonly descriptor: FontDescriptor;
  readonly fallbackName: string;
  readonly useMetadata: boolean;
}

/** Owns bounded, validated bytes until explicit review acceptance or cancellation. */
export class FontImportStaging {
  readonly #prepared = new Map<PreparedLibraryFontFace, PreparedFontData>();
  #ownedBytes = 0;
  #pending = 0;
  #disposed = false;

  public async prepare(
    bytes: Uint8Array,
    options: FontPreparationOptions,
    scheduler: WorkScheduler,
    sanitize: (bytes: Uint8Array<ArrayBuffer>, face: FontDescriptor) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<PreparedLibraryFontFace> {
    this.#assertLive(signal);
    const ownedBytes = this.#reserve(bytes.length);
    let retained = false;
    try {
      const owned = new Uint8Array(bytes);
      const prepared = await this.#validate(owned, options, scheduler, sanitize, signal);
      this.#assertLive(signal);
      this.#prepared.set(prepared, { bytes: owned, ownedBytes });
      retained = true;
      return prepared;
    } finally {
      this.#pending -= 1;
      if (!retained) this.#ownedBytes -= ownedBytes;
    }
  }

  public bytes(prepared: PreparedLibraryFontFace, signal?: AbortSignal): Uint8Array<ArrayBuffer> {
    this.#assertLive(signal);
    const data = this.#prepared.get(prepared);
    if (data === undefined)
      throw new FontImportError("invalid-prepared", "The prepared font is no longer available.");
    return data.bytes;
  }

  public release(prepared: PreparedLibraryFontFace): void {
    const data = this.#prepared.get(prepared);
    if (data === undefined) return;
    this.#prepared.delete(prepared);
    this.#ownedBytes -= data.ownedBytes;
  }

  public dispose(): void {
    this.#disposed = true;
    for (const prepared of this.#prepared.keys()) this.release(prepared);
  }

  #reserve(length: number): number {
    if (length > FONT_LIMITS.fileBytes)
      throw new FontImportError("file-limit", "Font exceeds limit.");
    // Include the owned binary and its portable base64 resource before either allocation.
    const ownedBytes = length + Math.ceil(length / 3) * 4 * 2;
    if (
      this.#prepared.size + this.#pending >= FONT_LIMITS.libraryFaces ||
      ownedBytes > FONT_LIMITS.documentBytes - this.#ownedBytes
    ) {
      throw new FontImportError("staging-limit", "The staged font selection exceeds its limit.");
    }
    this.#ownedBytes += ownedBytes;
    this.#pending += 1;
    return ownedBytes;
  }

  async #validate(
    bytes: Uint8Array<ArrayBuffer>,
    options: FontPreparationOptions,
    scheduler: WorkScheduler,
    sanitize: (bytes: Uint8Array<ArrayBuffer>, face: FontDescriptor) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<PreparedLibraryFontFace> {
    let resource: FontResourceV2;
    let familyName: string;
    try {
      const metadata = options.useMetadata
        ? await readImportedFontMetadata(bytes, scheduler, signal)
        : undefined;
      const descriptor = { ...options.descriptor, ...metadata };
      resource = await createFontResource(bytes, descriptor, scheduler, signal);
      familyName = metadata?.familyName ?? options.fallbackName.replace(/\.(ttf|otf|woff2?)$/i, "");
    } catch (cause) {
      this.#assertLive(signal);
      throw new FontImportError("invalid-font", "Invalid or unsupported font container.", {
        cause,
      });
    }
    this.#assertLive(signal);
    try {
      await sanitize(bytes, resource);
    } catch (cause) {
      this.#assertLive(signal);
      throw new FontImportError(
        "native-rejected",
        cause instanceof Error ? cause.message : "The native font loader rejected this font.",
        { cause },
      );
    }
    if (resource.weightRange !== undefined) Object.freeze(resource.weightRange);
    Object.freeze(resource);
    return Object.freeze({
      id: resource.id,
      fileName: options.fallbackName,
      familyName,
      weight: resource.weight,
      style: resource.style,
      ...(resource.weightRange === undefined ? {} : { weightRange: resource.weightRange }),
      resource,
    });
  }

  #assertLive(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.#disposed) throw new Error("Font library disposed.");
  }
}
