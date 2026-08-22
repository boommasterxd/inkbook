interface LruEntry<T> {
  readonly bytes: number;
  readonly value: T;
  readonly version: number;
}

export interface LruStatistics {
  readonly bytes: number;
  readonly entries: number;
  readonly evictions: number;
  readonly hits: number;
}

/** A small entry-and-byte bounded LRU whose replacement releases the old value immediately. */
export class BoundedVersionLru<T> {
  readonly #entries = new Map<string, LruEntry<T>>();
  readonly #maximumBytes: number;
  readonly #maximumEntries: number;
  #bytes = 0;
  #evictions = 0;
  #hits = 0;

  public constructor(maximumEntries: number, maximumBytes: number) {
    assertPositiveSafeInteger(maximumEntries, "maximumEntries");
    assertPositiveSafeInteger(maximumBytes, "maximumBytes");
    this.#maximumEntries = maximumEntries;
    this.#maximumBytes = maximumBytes;
  }

  public get retainedBytes(): number {
    return this.#bytes;
  }

  public get(id: string, version: number): T | undefined {
    return this.access(id, version, "retain");
  }

  public take(id: string, version: number): T | undefined {
    return this.access(id, version, "take");
  }

  private access(id: string, version: number, mode: "retain" | "take"): T | undefined {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    if (entry.version !== version) {
      this.delete(id);
      return undefined;
    }
    this.#entries.delete(id);
    if (mode === "retain") this.#entries.set(id, entry);
    else this.#bytes -= entry.bytes;
    this.#hits += 1;
    return entry.value;
  }

  public set(id: string, version: number, value: T, bytes: number): void {
    assertNonNegativeSafeInteger(bytes, "bytes");
    this.delete(id);
    if (bytes > this.#maximumBytes) return;
    this.#entries.set(id, { bytes, value, version });
    this.#bytes += bytes;
    this.evictToLimits();
  }

  public delete(id: string): boolean {
    const entry = this.#entries.get(id);
    if (entry === undefined) return false;
    this.#entries.delete(id);
    this.#bytes -= entry.bytes;
    return true;
  }

  public clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  public resetStatistics(): void {
    this.#evictions = 0;
    this.#hits = 0;
  }

  public statistics(): LruStatistics {
    return {
      bytes: this.#bytes,
      entries: this.#entries.size,
      evictions: this.#evictions,
      hits: this.#hits,
    };
  }

  private evictToLimits(): void {
    while (this.#entries.size > this.#maximumEntries || this.#bytes > this.#maximumBytes) {
      const oldest = this.#entries.entries().next().value;
      if (oldest === undefined) return;
      this.#entries.delete(oldest[0]);
      this.#bytes -= oldest[1].bytes;
      this.#evictions += 1;
    }
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}
