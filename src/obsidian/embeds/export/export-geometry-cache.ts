import type { PreparedExportCuts } from "../../../domain/export/export-pagination";
import { BoundedVersionLru } from "../../../domain/cache/bounded-version-lru";
import type { StaticExportFragment } from "../../../persistence/export/static-export-fragments";
import type { LoadedPreviewSvg } from "../preview/safe-preview-svg";

export const EXPORT_GEOMETRY_CACHE_LIMITS = {
  entries: 8,
  numericBytes: 8 * 1024 * 1024,
} as const;

export interface CachedExportGeometry {
  readonly cuts: PreparedExportCuts | undefined;
  readonly fragments: readonly StaticExportFragment[] | undefined;
}

/** Plugin-owned, export-only LRU. Retains neither source descriptors nor pending work. */
export class ExportGeometryCache {
  readonly #entries = new BoundedVersionLru<CachedExportGeometry>(
    EXPORT_GEOMETRY_CACHE_LIMITS.entries,
    EXPORT_GEOMETRY_CACHE_LIMITS.numericBytes,
  );
  #disposed = false;

  public get instrumentation(): { readonly entries: number; readonly numericBytes: number } {
    const { entries, bytes } = this.#entries.statistics();
    return { entries, numericBytes: bytes };
  }

  public async prepare(
    descriptor: LoadedPreviewSvg,
    prepare: () => Promise<CachedExportGeometry>,
    signal: AbortSignal,
  ): Promise<CachedExportGeometry> {
    signal.throwIfAborted();
    if (this.#disposed) return { cuts: undefined, fragments: undefined };
    // Recognition must validate the current source before this full-content identity is used.
    const { outputHash, revision } = descriptor.contentIdentity;
    const key = JSON.stringify([outputHash, revision]);
    const cached = this.#entries.get(key, revision);
    if (cached !== undefined) return cached;
    const geometry = await prepare();
    signal.throwIfAborted();
    if (this.#disposed) return { cuts: undefined, fragments: undefined };
    if (geometry.cuts !== undefined && geometry.fragments !== undefined) {
      this.#entries.set(
        key,
        revision,
        { cuts: geometry.cuts, fragments: geometry.fragments },
        retainedNumericBytes(geometry),
      );
    }
    return geometry;
  }

  public dispose(): void {
    this.#disposed = true;
    this.#entries.clear();
  }
}

function retainedNumericBytes(geometry: CachedExportGeometry): number {
  const events = geometry.cuts!.instrumentation.eventCount;
  const base = 2 ** Math.ceil(Math.log2(Math.max(1, events)));
  // ExportCutIndex owns three numeric fields per event, a 2*base tree, and two scalars.
  // Include the LRU entry size/version and three slots per fragment (including its boolean).
  // Count the unused tree slot conservatively. Entry/event counts also bound object overhead;
  // this is a numeric-payload budget, not a claim about JavaScript heap representation.
  return (
    (3 * events + 2 * base + 4 + 3 * geometry.fragments!.length) * Float64Array.BYTES_PER_ELEMENT
  );
}
