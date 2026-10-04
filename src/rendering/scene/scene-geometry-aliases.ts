import { BoundedVersionLru } from "../../domain/cache/bounded-version-lru";

interface GeometryAlias {
  readonly key: string;
  readonly version: number | undefined;
}

/** Bounded ID/version access keys; contours remain owned by the geometry cache. */
export class SceneGeometryAliases {
  readonly #entries: BoundedVersionLru<GeometryAlias>;
  readonly #keys = new Map<string, string>();
  readonly #owners = new Map<string, Set<string>>();
  readonly #maximumBytes: number;

  public constructor(maximumEntries: number, maximumBytes: number) {
    this.#maximumBytes = maximumBytes;
    this.#entries = new BoundedVersionLru(maximumEntries, maximumBytes, (id, alias) => {
      this.#keys.delete(id);
      const owners = this.#owners.get(alias.key);
      owners?.delete(id);
      if (owners?.size === 0) this.#owners.delete(alias.key);
    });
  }

  public read(id: string, version: number): string | undefined {
    const alias = this.#entries.get(id, 0);
    return alias?.version === version ? alias.key : undefined;
  }

  public retain(id: string, version: number | undefined, key: string): void {
    if (version === undefined && this.#keys.get(id) === key) return;
    const bytes = 128 + (id.length + key.length) * 2;
    if (bytes > this.#maximumBytes) return;
    this.#entries.set(id, 0, { key, version }, bytes);
    this.#keys.set(id, key);
    const owners = this.#owners.get(key) ?? new Set<string>();
    owners.add(id);
    this.#owners.set(key, owners);
  }

  public invalidate(id: string): string | undefined {
    const key = this.#keys.get(id);
    this.#entries.delete(id);
    return key;
  }

  public hasOwners(key: string): boolean {
    return this.#owners.has(key);
  }

  public invalidateKey(key: string): void {
    const owners = this.#owners.get(key);
    if (owners !== undefined) for (const id of owners) this.#entries.delete(id);
  }

  public release(): void {
    this.#entries.clear();
  }

  public memoryUsage(): number {
    return this.#entries.retainedBytes;
  }
}
