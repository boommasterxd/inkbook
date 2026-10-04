import type { RenderBand } from "../../domain/commands/render-bands";
import type { MountedSceneElement } from "./mounted-element";
import type { SceneElementRecord, SceneStorePort } from "./types";

interface RootBlock {
  readonly band: RenderBand;
  readonly entries: MountedSceneElement[];
}

const MAXIMUM_BLOCK_ENTRIES = 128;

/** Bounded blocks avoid moving a complete retained band for each new SVG root. */
export class ConnectedRootOrder {
  readonly #bands: Record<RenderBand, RootBlock[]> = { content: [], highlight: [] };
  readonly #owners = new Map<string, RootBlock>();
  readonly #ranks = new WeakMap<MountedSceneElement, { epoch: number; rank: number }>();
  #epoch = 0;
  #store: SceneStorePort | undefined;

  public invalidateRanks(): void {
    this.#epoch += 1;
  }

  public add(entry: MountedSceneElement, store?: SceneStorePort): void {
    this.#store = store ?? this.#store;
    if (this.#owners.has(entry.id)) return;
    this.#ranks.set(entry, { epoch: this.#epoch, rank: entry.rank });
    const blocks = this.#bands[entry.band];
    const index = this.blockIndex(entry, blocks);
    const block = blocks[index] ?? blocks[index - 1] ?? { band: entry.band, entries: [] };
    if (blocks.length === 0) blocks.push(block);
    block.entries.splice(this.entryIndex(entry, block.entries), 0, entry);
    this.#owners.set(entry.id, block);
    if (block.entries.length <= MAXIMUM_BLOCK_ENTRIES) return;
    const next = { band: block.band, entries: block.entries.splice(MAXIMUM_BLOCK_ENTRIES / 2) };
    blocks.splice(blocks.indexOf(block) + 1, 0, next);
    for (const moved of next.entries) this.#owners.set(moved.id, next);
  }

  public remove(id: string): void {
    const block = this.#owners.get(id);
    if (block === undefined) return;
    this.#owners.delete(id);
    const index = block.entries.findIndex((entry) => entry.id === id);
    block.entries.splice(index, 1);
    const blocks = this.#bands[block.band];
    const position = blocks.indexOf(block);
    if (block.entries.length === 0) {
      blocks.splice(position, 1);
      return;
    }
    if (block.entries.length >= MAXIMUM_BLOCK_ENTRIES / 4) return;
    const neighbor = blocks[position + 1] ?? blocks[position - 1];
    if (
      neighbor === undefined ||
      block.entries.length + neighbor.entries.length > MAXIMUM_BLOCK_ENTRIES
    )
      return;
    const left = blocks.indexOf(neighbor) < position ? neighbor : block;
    const right = left === block ? neighbor : block;
    left.entries.push(...right.entries);
    for (const moved of right.entries) this.#owners.set(moved.id, left);
    blocks.splice(blocks.indexOf(right), 1);
  }

  public successor(
    record: Pick<SceneElementRecord, "id" | "rank" | "band">,
  ): MountedSceneElement | undefined {
    const blocks = this.#bands[record.band];
    const block = blocks[this.blockIndex(record, blocks)];
    return block?.entries[this.entryIndex(record, block.entries)];
  }

  public memoryUsage(): number {
    return this.#owners.size * 80;
  }

  public clear(): void {
    this.#owners.clear();
    this.#bands.content.length = 0;
    this.#bands.highlight.length = 0;
    this.#store = undefined;
  }

  private blockIndex(
    record: Pick<SceneElementRecord, "id" | "rank">,
    blocks: readonly RootBlock[],
  ): number {
    let low = 0;
    let high = blocks.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const entries = blocks[middle]!.entries;
      if (this.earlier(entries[entries.length - 1]!, record)) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private entryIndex(
    record: Pick<SceneElementRecord, "id" | "rank">,
    entries: readonly MountedSceneElement[],
  ): number {
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.earlier(entries[middle]!, record)) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private earlier(
    entry: MountedSceneElement,
    record: Pick<SceneElementRecord, "id" | "rank">,
  ): boolean {
    let cached = this.#ranks.get(entry);
    if (cached?.epoch !== this.#epoch) {
      cached = { epoch: this.#epoch, rank: this.#store?.get(entry.id)?.rank ?? entry.rank };
      this.#ranks.set(entry, cached);
    }
    return (
      cached.rank < record.rank ||
      (cached.rank === record.rank && entry.id.localeCompare(record.id) <= 0)
    );
  }
}
