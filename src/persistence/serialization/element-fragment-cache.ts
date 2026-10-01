import type { InkElementV1 } from "../../domain/schema/public";
import {
  canonicalStrokeMetadataFrame,
  serializeCanonicalElementMetadata,
} from "./canonical-element-fragments";
import type { ElementFragments } from "./element-fragments";

const MAXIMUM_ELEMENTS = 20_000;
const MAXIMUM_BYTES = 64 * 1024 * 1024;

export class ElementFragmentCache {
  readonly #entries = new Map<string, ElementFragments>();
  #ownedRuntimeElements = new WeakSet<InkElementV1>();
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
  /** Called only after successful validation by composition that owns immutable runtime samples. */
  public retainRuntimeOwnership(element: InkElementV1): void {
    this.#ownedRuntimeElements.add(element);
  }
  /** Only runtime composition may attest exclusive immutable ownership after full validation. */
  public adopt(element: InkElementV1, ownsRuntimeSamples = false): void {
    const cached = this.#entries.get(element.id);
    const ownedSource = cached !== undefined && this.#ownedRuntimeElements.has(cached.element);
    if (ownsRuntimeSamples) this.retainRuntimeOwnership(element);
    if (cached === undefined) return;
    const matching =
      ownsRuntimeSamples &&
      ownedSource &&
      cached.element.kind === "stroke" &&
      element.kind === "stroke" &&
      cached.element.points instanceof Float64Array &&
      element.points instanceof Float64Array
        ? sameRuntimeStrokeMetadata(cached.element, element)
        : cached.canonicalMetadata === serializeCanonicalElementMetadata(element);
    if (!matching) {
      this.remove(element.id);
      return;
    }
    const descriptors = Object.getOwnPropertyDescriptors(cached);
    this.#entries.set(
      element.id,
      Object.defineProperties(
        {},
        {
          ...descriptors,
          element: { value: element, enumerable: true, configurable: true },
        },
      ) as ElementFragments,
    );
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
    this.#ownedRuntimeElements = new WeakSet();
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

function sameRuntimeStrokeMetadata(
  source: Extract<InkElementV1, { kind: "stroke" }>,
  element: Extract<InkElementV1, { kind: "stroke" }>,
): boolean {
  const before = canonicalStrokeMetadataFrame(source);
  const after = canonicalStrokeMetadataFrame(element);
  if (before.prefix !== after.prefix || before.suffix !== after.suffix) return false;
  if (source.points === element.points) return true;
  if (source.points.length !== element.points.length) return false;
  for (let index = 0; index < source.points.length; index += 1) {
    if (!Object.is(source.points[index], element.points[index])) return false;
  }
  return true;
}
