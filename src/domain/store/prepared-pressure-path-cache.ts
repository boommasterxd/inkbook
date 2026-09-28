import { VersionedCache } from "../cache/versioned-cache";
import type { SvgPathPart } from "../geometry/svg-path-part";

/** Internally generated local pressure paths, bounded independently of selection windows. */
export class PreparedPressurePathCache extends VersionedCache<readonly SvgPathPart[]> {
  readonly #versions: Map<string, number>;
  public constructor(
    private readonly maximumBytes = 4 * 1024 * 1024,
    maximumEntries = 1024,
  ) {
    const versions = new Map<string, number>();
    super(maximumEntries, maximumBytes, (id) => versions.delete(id));
    this.#versions = versions;
  }

  public cachedVersions(): IterableIterator<readonly [string, number]> {
    return this.#versions.entries();
  }

  public *versionsFor(ids: ReadonlySet<string>): IterableIterator<readonly [string, number]> {
    if (ids.size < this.#versions.size) {
      for (const id of ids) {
        const version = this.#versions.get(id);
        if (version !== undefined) yield [id, version];
      }
    } else {
      for (const [id, version] of this.#versions) {
        if (ids.has(id)) yield [id, version];
      }
    }
  }

  public read(id: string, version: number): readonly SvgPathPart[] | undefined {
    return this.getCached(id, version);
  }

  public publish(id: string, version: number, parts: readonly SvgPathPart[]): void {
    if (!this.retentionEnabled || parts.length !== 1 || parts[0]!.paint !== "fill") return;
    const bytes = 128 + id.length * 2 + parts[0]!.d.length * 2;
    if (bytes > this.maximumBytes) return;
    this.retainCached(
      id,
      version,
      Object.freeze(parts.map((part) => Object.freeze({ ...part }))),
      bytes,
    );
    this.#versions.set(id, version);
  }
}
