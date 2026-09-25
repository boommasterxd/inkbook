import { VersionedCache } from "../cache/versioned-cache";
import type { SvgPathPart } from "../geometry/svg-path-part";

/** Canonical validated unlock paths, bounded independently of selection windows. */
export class PreparedPressurePathCache extends VersionedCache<readonly SvgPathPart[]> {
  public constructor(
    private readonly maximumBytes = 4 * 1024 * 1024,
    maximumEntries = 1024,
  ) {
    super(maximumEntries, maximumBytes);
  }

  public read(id: string, version: number): readonly SvgPathPart[] | undefined {
    return this.getCached(id, version);
  }

  public publish(id: string, version: number, parts: readonly SvgPathPart[]): void {
    if (!this.retentionEnabled || parts.length !== 1 || parts[0]!.paint !== "fill") return;
    const bytes = 64 + id.length * 2 + parts[0]!.d.length * 2;
    if (bytes > this.maximumBytes) return;
    this.retainCached(
      id,
      version,
      Object.freeze(parts.map((part) => Object.freeze({ ...part }))),
      bytes,
    );
  }
}
