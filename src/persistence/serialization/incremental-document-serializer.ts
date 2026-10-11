import { StrokeShapeCache } from "./stroke-shape-cache";
import { prepareCachedScenePath } from "./scene-path-preparation";
import type { SvgPathPart } from "../../domain/geometry/svg-path-part";
import { StrokeSampleEncodingCache } from "./stroke-sample-encoding-cache";
import { matchesPreparedPressurePath } from "./prepared-pressure-hints";
import {
  type InkElementV1,
  type InkSnapshotV1,
  type PageV1,
  type SnapshotValidationDerivations,
} from "../../domain/schema/public";
import { BackgroundFragmentCache } from "./background";
import { canonicalElement, canonicalPage } from "./canonical-snapshot";
import {
  canonicalMetadataFragmentsSha256,
  metadataPrefix as canonicalMetadataPrefix,
} from "./canonical-metadata";
import { codecFailure } from "./codec-failure";
import {
  ChunkedOutputCancelledError,
  type ChunkedOutputAssemblyOptions,
} from "./chunked-output-assembler";
import {
  envelope,
  orderedSnapshotValue,
  snapshotMetadata,
  snapshotValue,
} from "./document-assembly";
import { buildElementFragments, type ElementFragments, type RenderBand } from "./element-fragments";
import { ElementFragmentCache } from "./element-fragment-cache";
import {
  prepareDocumentDeltaSteps,
  validateDocumentDeltaSteps,
} from "./incremental-document-delta";
import {
  prepareSerializationModelSteps,
  consumeSerializationSteps,
  completeSerializationSteps,
  type PreparedSerializationModel,
} from "./serialization-model-preparation";
import * as incrementalValidation from "./incremental-validation";
import type {
  DocumentSerializationDelta,
  FragmentSerializerInstrumentation,
} from "./incremental-document-serializer-types";
import { checkBackgroundLimit, prepareSerialization } from "./serialization-budgets";
import { assembleOrderedElementFragments } from "./ordered-element-fragments";
import {
  captureDeltaInputSteps,
  copySerializationElementsSteps,
} from "./serialization-input-preparation";
import { SHA256_DOCUMENT_HASHER, type DocumentHashPort } from "./sha256";
import { serializeRuntimeSnapshotToUtf8 } from "./streaming-runtime-export";
import {
  prepareSerializationRanks,
  serializationSelectionSteps,
  type SerializationRank,
} from "./serialization-selection";
import type { DocumentCodecResult, SerializedInkbookDocument } from "./types";
export class IncrementalDocumentSerializer {
  #cache = new ElementFragmentCache();
  readonly #shapeCache = new StrokeShapeCache((stroke) => this.#elements.get(stroke.id) === stroke);
  #elements = new Map<string, InkElementV1>();
  public readonly sampleEncodingCache = new StrokeSampleEncodingCache((stroke) => {
    const current = this.#elements.get(stroke.id);
    return (
      this.#runtimeStrokeBuffers &&
      current?.kind === "stroke" &&
      current.points === stroke.points &&
      stroke.points instanceof Float64Array
    );
  });
  #facts = new Map<string, incrementalValidation.ElementFacts>();
  #orders: Record<RenderBand, string[]> = { content: [], highlight: [] };
  #ranks = new Map<string, SerializationRank>();
  #epoch = 0;
  readonly #backgroundCache = new BackgroundFragmentCache();
  #fragmentBuilds = 0;
  #fragmentHits = 0;
  #derivedBoundsReuses = 0;
  #fullValidationRuns = 0;
  #incrementalValidationRuns = 0;
  #aggregateFacts = incrementalValidation.emptyAggregateFacts();
  #page: PageV1 | null = null;
  #revision: number | null = null;
  #runtimeStrokeBuffers = false;
  public get instrumentation(): FragmentSerializerInstrumentation {
    return {
      backgroundBuilds: this.#backgroundCache.builds,
      ...this.#shapeCache.instrumentation,
      ...this.sampleEncodingCache.instrumentation,
      cacheBytes: this.#cache.retainedBytes,
      cacheElements: this.#cache.size,
      derivedBoundsReuses: this.#derivedBoundsReuses,
      fragmentBuilds: this.#fragmentBuilds,
      fragmentHits: this.#fragmentHits,
      fullValidationRuns: this.#fullValidationRuns,
      incrementalValidationRuns: this.#incrementalValidationRuns,
    };
  }
  public currentSnapshot(): InkSnapshotV1 | null {
    return orderedSnapshotValue(this.#revision, this.#page, this.#elements, this.#orders);
  }
  public currentRevision(): number | null {
    return this.#revision;
  }
  public selectionSteps(ids: readonly string[]) {
    return serializationSelectionSteps(this.#elements, this.#ranks, ids);
  }
  public currentPage(): PageV1 | null {
    return this.#page === null ? null : canonicalPage(this.#page);
  }
  public seedPreparedPressurePath(id: string, d: string, shapeKey: string): boolean {
    const element = this.#elements.get(id);
    if (!matchesPreparedPressurePath(element, shapeKey)) return false;
    this.#shapeCache.seed(element, d);
    return true;
  }
  public hasElement(id: string): boolean {
    return this.#elements.has(id);
  }
  public async prepareScenePath(
    id: string,
    context: { readonly signal: AbortSignal; checkpoint(): Promise<void> | undefined },
  ): Promise<readonly SvgPathPart[] | undefined> {
    return prepareCachedScenePath(
      {
        current: (key) => this.#elements.get(key),
        shapes: this.#shapeCache,
        fragments: this.#cache,
      },
      id,
      context,
    );
  }
  public currentElementCount(): number {
    return this.#elements.size;
  }
  /** Valid after successful serialization has checked every current element identity. */
  public hasCompleteFragmentCache(): boolean {
    return this.#cache.size === this.#elements.size;
  }
  public currentAggregateFacts(): Readonly<incrementalValidation.AggregateFacts> | null {
    return this.#revision === null ? null : { ...this.#aggregateFacts };
  }
  public prewarmElement(id: string, maximumBytes: number): number | null {
    const element = this.#elements.get(id);
    if (element === undefined) return null;
    const bytes = this.#cache.prewarm(
      element,
      this.#facts.get(id)!.bottom,
      this.#shapeCache,
      this.sampleEncodingCache,
      maximumBytes,
    );
    if (bytes !== null && bytes > 0) this.#fragmentBuilds += 1;
    return bytes;
  }
  public async prewarmElementAtSliced(
    index: number,
    maximumBytes: number,
    options: ChunkedOutputAssemblyOptions,
  ): Promise<number | null> {
    const highlight = this.#orders.highlight;
    const id =
      index < highlight.length ? highlight[index] : this.#orders.content[index - highlight.length];
    const element = id === undefined ? undefined : this.#elements.get(id);
    if (element === undefined) return null;
    if (this.#cache.current(element) !== undefined) return 0;
    const fragments = await this.#fragmentsForSliced(element, options, maximumBytes);
    return fragments.bytes > maximumBytes ? null : fragments.bytes;
  }
  public reset(snapshot: InkSnapshotV1): DocumentCodecResult<void> {
    return this.#reset(snapshot, false);
  }
  /** Runtime composition may explicitly attest exclusive immutable sample ownership. */
  public resetRuntime(snapshot: InkSnapshotV1, ownsSamples = false): DocumentCodecResult<void> {
    return this.#reset(snapshot, true, undefined, ownsSamples);
  }
  public resetValidatedRuntime(
    snapshot: InkSnapshotV1,
    derivations: SnapshotValidationDerivations,
    ownsSamples = false,
  ): DocumentCodecResult<void> {
    return this.#reset(snapshot, true, derivations, ownsSamples);
  }
  #reset(
    snapshot: InkSnapshotV1,
    runtimeStrokeBuffers: boolean,
    validatedDerivations?: SnapshotValidationDerivations,
    ownsRuntimeSamples = false,
  ): DocumentCodecResult<void> {
    if (validatedDerivations === undefined) this.#fullValidationRuns += 1;
    const prepared = completeSerializationSteps(
      prepareSerializationModelSteps(snapshot, {
        runtimeStrokeBuffers,
        ownsRuntimeSamples,
        ...(validatedDerivations === undefined ? {} : { derivations: validatedDerivations }),
        nodesPerStep: Infinity,
      }),
    );
    if (!prepared.ok) return prepared;
    this.#adoptModel(
      prepared.value,
      completeSerializationSteps(
        this.#cache.prepareResetSteps(prepared.value.elements, ownsRuntimeSamples, Infinity),
      ),
    );
    return { ok: true, value: undefined };
  }
  public async resetRuntimeSliced(
    snapshot: InkSnapshotV1,
    context: { readonly signal: AbortSignal; checkpoint(): Promise<void> | undefined },
    ownsSamples = false,
  ): Promise<DocumentCodecResult<void>> {
    const epoch = this.#epoch;
    const prepared = await consumeSerializationSteps(
      prepareSerializationModelSteps(snapshot, {
        runtimeStrokeBuffers: true,
        ownsRuntimeSamples: ownsSamples,
      }),
      context,
    );
    this.#fullValidationRuns += 1;
    if (!prepared.ok) return prepared;
    const cache = await consumeSerializationSteps(
      this.#cache.prepareResetSteps(prepared.value.elements, true),
      context,
    );
    context.signal.throwIfAborted();
    if (epoch !== this.#epoch)
      return codecFailure("base-revision-mismatch", "The staged model is stale.");
    this.#adoptModel(prepared.value, cache);
    return { ok: true, value: undefined };
  }
  #adoptModel(model: PreparedSerializationModel, cache: ElementFragmentCache): void {
    this.sampleEncodingCache.reconcileElements(model.elements);
    for (const id of this.#shapeCache.ids()) {
      if (!model.elements.has(id)) this.#shapeCache.remove(id);
    }
    this.#cache = cache;
    this.#elements = model.elements;
    this.#facts = model.facts;
    this.#orders = model.orders;
    this.#ranks = model.ranks;
    this.#page = model.page;
    this.#revision = model.revision;
    this.#runtimeStrokeBuffers = model.runtimeStrokeBuffers;
    this.#aggregateFacts = model.aggregate;
    this.#derivedBoundsReuses += model.elements.size;
    this.#epoch += 1;
  }
  public applyDelta(
    delta: DocumentSerializationDelta,
    ownsSamples = false,
  ): DocumentCodecResult<void> {
    return completeSerializationSteps(this.#applyDeltaSteps(delta, ownsSamples, Infinity));
  }
  public async applyDeltaSliced(
    delta: DocumentSerializationDelta,
    context: { readonly signal: AbortSignal; checkpoint(): Promise<void> | undefined },
    ownsSamples = false,
  ): Promise<DocumentCodecResult<void>> {
    if (!ownsSamples) {
      const header = await consumeSerializationSteps(captureDeltaInputSteps(delta), context);
      delta = {
        ...header,
        ...(header.changedElements === undefined
          ? {}
          : {
              changedElements: await consumeSerializationSteps(
                copySerializationElementsSteps(header.changedElements),
                context,
              ),
            }),
      };
    }
    return consumeSerializationSteps(
      this.#applyDeltaSteps(delta, true, 256, context.signal),
      context,
    );
  }
  *#applyDeltaSteps(
    delta: DocumentSerializationDelta,
    ownsSamples: boolean,
    nodesPerStep: number,
    signal?: AbortSignal,
  ): Generator<boolean | void, DocumentCodecResult<void>> {
    const epoch = this.#epoch;
    if (this.#revision === null || delta.baseModelRevision !== this.#revision) {
      return codecFailure(
        "base-revision-mismatch",
        "Delta base revision does not match the model.",
      );
    }
    const prepared = yield* prepareDocumentDeltaSteps(
      {
        currentElements: this.#elements,
        currentOrders: this.#orders,
        currentPage: this.#page!,
        delta,
      },
      nodesPerStep,
    );
    if (!prepared.ok) return prepared;
    const facts = yield* validateDocumentDeltaSteps(
      {
        aggregate: this.#aggregateFacts,
        currentElements: this.#elements,
        currentFacts: this.#facts,
        currentPage: this.#page!,
        pageChanged: delta.page !== undefined,
        prepared: prepared.value,
        runtimeStrokeBuffers: this.#runtimeStrokeBuffers,
      },
      nodesPerStep,
    );
    if (!facts.ok) return facts;
    const ranks =
      prepared.value.orders === this.#orders
        ? this.#ranks
        : yield* prepareSerializationRanks(prepared.value.orders, nodesPerStep);
    const changed = new Map<string, InkElementV1>();
    for (const element of prepared.value.changed.values()) {
      changed.set(element.id, canonicalElement(element, this.#runtimeStrokeBuffers, !ownsSamples));
      if (changed.size % nodesPerStep === 0) yield;
    }
    signal?.throwIfAborted();
    if (epoch !== this.#epoch)
      return codecFailure("base-revision-mismatch", "The staged model is stale.");
    for (const id of prepared.value.removed) {
      this.sampleEncodingCache.retire(this.#elements.get(id));
      this.#facts.delete(id);
      this.#elements.delete(id);
      this.#cache.remove(id);
      this.#shapeCache.retire(id);
    }
    for (const element of changed.values()) {
      if (ownsSamples) this.#cache.retainRuntimeOwnership(element);
      this.#elements.set(element.id, element);
      this.#facts.set(element.id, facts.value.changed.get(element.id)!);
      this.#cache.remove(element.id);
      this.sampleEncodingCache.reconcileElement(element);
    }
    this.#orders.highlight = prepared.value.orders.highlight;
    this.#orders.content = prepared.value.orders.content;
    this.#ranks = ranks;
    this.#page = canonicalPage(prepared.value.page);
    this.#revision = delta.modelRevision;
    this.#aggregateFacts = facts.value.aggregate;
    this.#derivedBoundsReuses += prepared.value.derivations.size;
    this.#incrementalValidationRuns += 1;
    this.#epoch += 1;
    return { ok: true, value: undefined };
  }
  public serialize(
    hasher: DocumentHashPort = SHA256_DOCUMENT_HASHER,
  ): DocumentCodecResult<SerializedInkbookDocument> {
    const prepared = prepareSerialization(
      this.#page,
      this.#revision,
      this.#aggregateFacts.maximumBottom,
      this.#backgroundCache,
    );
    if (!prepared.ok) return prepared;
    const {
      background,
      lockedHeight,
      output: outputBudget,
      metadata: metadataBudget,
      page,
      revision,
    } = prepared.value;
    const assembly = assembleOrderedElementFragments({
      orders: this.#orders,
      element: (id) => this.#elements.get(id)!,
      fragment: (element) => this.#fragmentsFor(element),
      outputBudget,
      metadataBudget,
    });
    if (!assembly.ok) return assembly;
    const metadata = snapshotMetadata(revision, page, assembly.value.metadata);
    const metadataHash = canonicalMetadataFragmentsSha256(
      canonicalMetadataPrefix(revision, page),
      assembly.value.canonicalMetadata,
    );
    const svg = envelope(
      revision,
      lockedHeight,
      { hash: metadataHash, text: metadata },
      background,
      assembly.value.highlights,
      assembly.value.content,
    );
    const metadataBytes = metadataBudget.usedBytes;
    const totalBytes = outputBudget.usedBytes;
    const snapshot = snapshotValue(revision, page, assembly.value.elements);
    return {
      ok: true,
      value: {
        hash: hasher.hash(svg),
        lockedHeight,
        metadataBytes,
        snapshot,
        snapshotHash: metadataHash,
        svg,
        totalBytes,
      },
    };
  }
  public async serializeChunked(
    options: ChunkedOutputAssemblyOptions = {},
  ): Promise<DocumentCodecResult<SerializedInkbookDocument>> {
    try {
      const serialized = await this.serializeRuntimeChunked(options);
      if (!serialized.ok) return serialized;
      return {
        ok: true,
        value: { ...serialized.value, svg: new TextDecoder().decode(serialized.value.svg) },
      };
    } catch (error) {
      if (options.signal?.aborted) throw new ChunkedOutputCancelledError();
      throw error;
    }
  }
  public serializeRuntimeChunked(
    options: ChunkedOutputAssemblyOptions,
  ): Promise<DocumentCodecResult<SerializedInkbookDocument<Uint8Array<ArrayBuffer>>>> {
    if (options.signal?.aborted) return Promise.reject(new ChunkedOutputCancelledError());
    const snapshot = this.currentSnapshot();
    if (snapshot === null) {
      return Promise.resolve(
        codecFailure("invalid-delta", "Serializer has no initialized document model."),
      );
    }
    const prepared = checkBackgroundLimit(snapshot.page, this.#aggregateFacts.maximumBottom);
    if (!prepared.ok) return Promise.resolve(prepared);
    return serializeRuntimeSnapshotToUtf8(
      snapshot,
      options,
      (element) => this.#fragmentsForSliced(element, options),
      this.#backgroundCache,
    );
  }
  public clear(): void {
    this.#epoch += 1;
    this.#cache.clear();
    this.#shapeCache.clear();
    this.sampleEncodingCache.clear();
    this.#backgroundCache.clear();
    this.#elements.clear();
    this.#facts.clear();
    this.#ranks.clear();
    this.#orders.content = [];
    this.#orders.highlight = [];
    this.#page = null;
    this.#revision = null;
    this.#runtimeStrokeBuffers = false;
    this.#aggregateFacts = incrementalValidation.emptyAggregateFacts();
  }
  #fragmentsFor(element: InkElementV1): ElementFragments {
    const cached = this.#cache.current(element);
    if (cached !== undefined) {
      this.#fragmentHits += 1;
      this.#cache.touch(element.id);
      return cached;
    }
    const fragments = buildElementFragments(
      element,
      this.#facts.get(element.id)?.bottom,
      this.#shapeCache,
      this.sampleEncodingCache,
    );
    this.#fragmentBuilds += 1;
    this.#cache.retainIfSpace(element.id, fragments);
    return fragments;
  }
  async #fragmentsForSliced(
    element: InkElementV1,
    options: ChunkedOutputAssemblyOptions,
    maximumBytes = Infinity,
  ): Promise<ElementFragments> {
    const epoch = this.#epoch;
    const { fragments, built } = await this.#cache.resolveSliced({
      element,
      bottom: this.#facts.get(element.id)!.bottom,
      shapeCache: this.#shapeCache,
      sampleCache: this.sampleEncodingCache,
      assembly: options,
      maximumBytes,
      isCurrent: () => epoch === this.#epoch && this.#elements.get(element.id) === element,
    });
    if (built) this.#fragmentBuilds += 1;
    else if (fragments.bytes <= maximumBytes) this.#fragmentHits += 1;
    return fragments;
  }
}
