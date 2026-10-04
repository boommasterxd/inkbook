import { BoundedVersionLru, type LruStatistics } from "./bounded-version-lru";

export abstract class VersionedCache<T> {
  readonly #lru: BoundedVersionLru<T>;
  #builds = 0;
  #policyEvictions = 0;
  #retentionEnabled = true;

  protected constructor(
    maximumEntries: number,
    maximumBytes: number,
    onRemoval?: (id: string, value: T) => void,
  ) {
    this.#lru = new BoundedVersionLru(maximumEntries, maximumBytes, onRemoval);
  }

  protected getCached(id: string, version: number): T | undefined {
    return this.#lru.get(id, version);
  }

  protected takeCached(id: string, version: number): T | undefined {
    return this.#lru.take(id, version);
  }

  protected retainCached(id: string, version: number, value: T, bytes: number): void {
    if (!this.#retentionEnabled) return;
    this.#lru.set(id, version, value, bytes);
  }

  protected recordBuild(): void {
    this.#builds += 1;
  }

  protected trimCachedToBytes(maximumBytes: number): void {
    this.#lru.trimToBytes(maximumBytes);
  }

  protected get cachedBytes(): number {
    return this.#lru.retainedBytes;
  }

  public get retentionEnabled(): boolean {
    return this.#retentionEnabled;
  }

  public invalidate(id: string): void {
    this.#lru.delete(id);
  }

  public release(): void {
    this.#lru.clear();
  }

  public setRetentionEnabled(enabled: boolean): void {
    if (enabled === this.#retentionEnabled) return;
    this.#retentionEnabled = enabled;
    if (!enabled) {
      this.#policyEvictions += this.#lru.statistics().entries;
      this.release();
    }
  }

  public resetStatistics(): void {
    this.#builds = 0;
    this.#policyEvictions = 0;
    this.#lru.resetStatistics();
  }

  public statistics(): LruStatistics & { readonly builds: number } {
    const statistics = this.#lru.statistics();
    return {
      ...statistics,
      builds: this.#builds,
      evictions: statistics.evictions + this.#policyEvictions,
    };
  }
}
