import type { InkElementV1 } from "../../domain/schema/public";
import {
  canonicalStrokeMetadataFrame,
  serializeCanonicalElementMetadata,
} from "./canonical-element-fragments";
import {
  buildElementFragments,
  buildElementFragmentsSteps,
  type ElementFragments,
} from "./element-fragments";
import type { StrokeShapeCache } from "./stroke-shape-cache";
import type { StrokeSampleEncodingCache } from "./stroke-sample-encoding-cache";
import type { ChunkedOutputAssemblyOptions } from "./chunked-output-assembler";
import { consumeSerializationSteps } from "./serialization-model-preparation";

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
  public prewarm(
    element: InkElementV1,
    bottom: number,
    shapeCache: StrokeShapeCache,
    sampleCache: StrokeSampleEncodingCache,
    maximumBytes: number,
  ): number | null {
    if (this.current(element) !== undefined) {
      this.touch(element.id);
      return 0;
    }
    const fragments = buildElementFragments(element, bottom, shapeCache, sampleCache);
    if (fragments.bytes > maximumBytes) return null;
    this.replace(element.id, fragments);
    return fragments.bytes;
  }
  public async resolveSliced(options: {
    readonly element: InkElementV1;
    readonly bottom: number;
    readonly shapeCache: StrokeShapeCache;
    readonly sampleCache: StrokeSampleEncodingCache;
    readonly assembly: ChunkedOutputAssemblyOptions;
    readonly isCurrent: () => boolean;
    readonly maximumBytes?: number;
  }): Promise<{ readonly fragments: ElementFragments; readonly built: boolean }> {
    const cached = this.current(options.element);
    if (cached !== undefined) {
      this.touch(options.element.id);
      return { fragments: cached, built: false };
    }
    const fragments = await consumeSerializationSteps(
      buildElementFragmentsSteps(
        options.element,
        options.bottom,
        options.shapeCache,
        options.sampleCache,
        options.assembly.signal,
      ),
      options.assembly,
    );
    options.assembly.signal?.throwIfAborted();
    if (!options.isCurrent()) throw new Error("The fragment model changed during preparation.");
    const built = fragments.bytes <= (options.maximumBytes ?? Infinity);
    if (built) this.retainIfSpace(options.element.id, fragments);
    return { fragments, built };
  }
  /** Called only after successful validation by composition that owns immutable runtime samples. */
  public retainRuntimeOwnership(element: InkElementV1): void {
    this.#ownedRuntimeElements.add(element);
  }
  /** Only runtime composition may attest exclusive immutable ownership after full validation. */
  public adopt(element: InkElementV1, ownsRuntimeSamples = false): void {
    const steps = this.#adoptionSteps(element, ownsRuntimeSamples, Infinity);
    let step = steps.next();
    while (!step.done) step = steps.next();
    const fragments = step.value;
    if (ownsRuntimeSamples) this.retainRuntimeOwnership(element);
    if (fragments === undefined) this.remove(element.id);
    else this.#entries.set(element.id, fragments);
  }
  /** Compare long owned samples off-model and preserve LRU order until the complete reset commits. */
  public *prepareResetSteps(
    elements: ReadonlyMap<string, InkElementV1>,
    ownsRuntimeSamples: boolean,
    samplesPerStep = 256,
  ): Generator<void, ElementFragmentCache> {
    const next = new ElementFragmentCache();
    let visited = 0;
    for (const id of this.#entries.keys()) {
      const element = elements.get(id);
      if (element !== undefined) {
        const fragments = yield* this.#adoptionSteps(element, ownsRuntimeSamples, samplesPerStep);
        if (fragments !== undefined) next.replace(id, fragments);
      }
      if (++visited % samplesPerStep === 0) yield;
    }
    if (ownsRuntimeSamples) {
      for (const element of elements.values()) {
        next.retainRuntimeOwnership(element);
        if (++visited % samplesPerStep === 0) yield;
      }
    }
    return next;
  }
  *#adoptionSteps(
    element: InkElementV1,
    ownsRuntimeSamples: boolean,
    samplesPerStep: number,
  ): Generator<void, ElementFragments | undefined> {
    const cached = this.#entries.get(element.id);
    const ownedSource = cached !== undefined && this.#ownedRuntimeElements.has(cached.element);
    if (cached === undefined) return undefined;
    const matching =
      ownsRuntimeSamples &&
      ownedSource &&
      cached.element.kind === "stroke" &&
      element.kind === "stroke" &&
      cached.element.points instanceof Float64Array &&
      element.points instanceof Float64Array
        ? yield* sameRuntimeStrokeMetadataSteps(cached.element, element, samplesPerStep)
        : cached.canonicalMetadata === serializeCanonicalElementMetadata(element);
    if (!matching) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(cached);
    return Object.defineProperties(
      {},
      {
        ...descriptors,
        element: { value: element, enumerable: true, configurable: true },
      },
    ) as ElementFragments;
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

function* sameRuntimeStrokeMetadataSteps(
  source: Extract<InkElementV1, { kind: "stroke" }>,
  element: Extract<InkElementV1, { kind: "stroke" }>,
  samplesPerStep: number,
): Generator<void, boolean> {
  const before = canonicalStrokeMetadataFrame(source);
  const after = canonicalStrokeMetadataFrame(element);
  if (before.prefix !== after.prefix || before.suffix !== after.suffix) return false;
  if (source.points === element.points) return true;
  if (source.points.length !== element.points.length) return false;
  for (let index = 0; index < source.points.length; index += 1) {
    if (!Object.is(source.points[index], element.points[index])) return false;
    if ((index + 1) % (samplesPerStep * 3) === 0) yield;
  }
  return true;
}
