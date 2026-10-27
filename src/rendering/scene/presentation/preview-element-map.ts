import type { InkElementV1 } from "../../../domain/schema/public";

/** Reads both preview owners without copying unchanged snapshots on every scene frame. */
export class PreviewElementMap implements ReadonlyMap<string, InkElementV1> {
  public constructor(
    private readonly immediate: ReadonlyMap<string, InkElementV1>,
    private readonly progressive: ReadonlyMap<string, InkElementV1>,
  ) {}

  public get size(): number {
    let size = this.progressive.size;
    for (const id of this.immediate.keys()) if (!this.progressive.has(id)) size += 1;
    return size;
  }

  public has(id: string): boolean {
    return this.progressive.has(id) || this.immediate.has(id);
  }

  public get(id: string): InkElementV1 | undefined {
    return this.progressive.get(id) ?? this.immediate.get(id);
  }

  public *entries(): MapIterator<[string, InkElementV1]> {
    for (const [id, element] of this.immediate) yield [id, this.progressive.get(id) ?? element];
    for (const entry of this.progressive) if (!this.immediate.has(entry[0])) yield entry;
  }

  public *keys(): MapIterator<string> {
    for (const [id] of this) yield id;
  }

  public *values(): MapIterator<InkElementV1> {
    for (const [, element] of this) yield element;
  }

  public forEach(
    callback: (value: InkElementV1, key: string, map: ReadonlyMap<string, InkElementV1>) => void,
    thisArg?: unknown,
  ): void {
    for (const [id, element] of this) callback.call(thisArg, element, id, this);
  }

  public [Symbol.iterator](): MapIterator<[string, InkElementV1]> {
    return this.entries();
  }
}
