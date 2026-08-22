import type { InkElementV1 } from "../../domain/schema/public";
import { serializeCanonicalElementMetadata, type ElementFragments } from "./element-fragments";

const MAXIMUM_ELEMENTS = 20_000;
const MAXIMUM_BYTES = 64 * 1024 * 1024;

export class ElementFragmentCache {
  readonly #entries = new Map<string, ElementFragments>();
  #bytes = 0;

  public get retainedBytes(): number {
    return this.#bytes;
  }
  public get size(): number {
    return this.#entries.size;
  }
  public ids(): IterableIterator<string> {
    return this.#entries.keys();
  }
  public current(element: InkElementV1): ElementFragments | undefined {
    const cached = this.#entries.get(element.id);
    return cached?.element === element ? cached : undefined;
  }
  public adopt(element: InkElementV1): void {
    const cached = this.#entries.get(element.id);
    if (cached === undefined) return;
    if (cached.canonicalMetadata !== serializeCanonicalElementMetadata(element)) {
      this.remove(element.id);
      return;
    }
    this.#entries.set(element.id, { ...cached, element });
  }
  public replace(id: string, fragments: ElementFragments): void {
    const previous = this.#entries.get(id);
    if (previous !== undefined) this.#bytes -= previous.retainedBytes;
    this.#entries.delete(id);
    this.#entries.set(id, fragments);
    this.#bytes += fragments.retainedBytes;
    this.#evict();
  }
  public retainIfSpace(id: string, fragments: ElementFragments): void {
    const previous = this.#entries.get(id);
    const nextBytes = this.#bytes - (previous?.retainedBytes ?? 0) + fragments.retainedBytes;
    const nextElements = this.#entries.size + (previous === undefined ? 1 : 0);
    if (nextElements > MAXIMUM_ELEMENTS || nextBytes > MAXIMUM_BYTES) return;
    this.replace(id, fragments);
  }
  public remove(id: string): void {
    const cached = this.#entries.get(id);
    if (cached === undefined) return;
    this.#entries.delete(id);
    this.#bytes -= cached.retainedBytes;
  }
  public touch(id: string): void {
    const cached = this.#entries.get(id);
    if (cached === undefined) return;
    this.#entries.delete(id);
    this.#entries.set(id, cached);
  }
  public clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }
  #evict(): void {
    while (this.#entries.size > MAXIMUM_ELEMENTS || this.#bytes > MAXIMUM_BYTES) {
      const oldest = this.#entries.entries().next().value;
      if (oldest === undefined) return;
      this.remove(oldest[0]);
    }
  }
}
