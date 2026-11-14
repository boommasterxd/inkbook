import { StrokeShapeCache } from "./stroke-shape-cache";
import { prepareCachedScenePath } from "./scene-path-preparation";
import type { SvgPathPart } from "../../../domain/geometry/svg-path-part";
import { StrokeSampleEncodingCache } from "../metadata/stroke-sample-encoding-cache";
import { matchesPreparedPressurePath } from "./prepared-pressure-hints";
import {
  type InkElementV1,
  type InkSnapshotV1,
  type PageV1,
  type SnapshotValidationDerivations,
} from "../../../domain/schema/public";
import { BackgroundFragmentCache } from "./background";
import { canonicalPage } from "../metadata/canonical-snapshot";
import { codecFailure } from "../codec-failure";
import {
  ChunkedOutputCancelledError,
  type ChunkedOutputAssemblyOptions,
} from "./chunked-output-assembler";
import * as document from "./document-assembly";
import { buildElementFragments, type ElementFragments, type RenderBand } from "./element-fragments";
import { ElementFragmentCache } from "./element-fragment-cache";
import * as deltaValidation from "./incremental-document-delta";
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
import { checkBackgroundLimit } from "./serialization-budgets";
import { serializeDocumentFragments } from "./synchronous-document-export";
import {
  captureDeltaInputSteps,
  copySerializationElementsSteps,
  canonicalizeSerializationElementsSteps,
} from "./serialization-input-preparation";
import { SHA256_DOCUMENT_HASHER, type DocumentHashPort } from "../sha256";
import { serializeRuntimeSnapshotToUtf8 } from "./streaming-runtime-export";
import {
  prepareSerializationRankUpdate,
  serializationSelectionSteps,
  type SerializationRanks,
} from "./serialization-selection";
import type { DocumentCodecResult, SerializedInkbookDocument } from "../types";
import {
  canonicalFontResource,
  snapshotTextResources,
  deltaTextElements,
  prepareDeltaFontResourcesSteps,
  retainsFontFaces,
} from "./text-fonts";
import { usedFontResourcesSteps } from "../../fonts/used-font-resources";
export class IncrementalDocumentSerializer {
  #fontResources: NonNullable<InkSnapshotV1["fontResources"]> = [];
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
  #connectionTargets = new Map<string, number>();
  #orders: Record<RenderBand, string[]> = { content: [], highlight: [] };
  #ranks: SerializationRanks = { content: new Map(), highlight: new Map() };
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
      connectionTargetEntries: this.#connectionTargets.size,
      derivedBoundsReuses: this.#derivedBoundsReuses,
      fragmentBuilds: this.#fragmentBuilds,
      fragmentHits: this.#fragmentHits,
      fullValidationRuns: this.#fullValidationRuns,
      incrementalValidationRuns: this.#incrementalValidationRuns,
    };
  }
  public currentSnapshot(): InkSnapshotV1 | null {
    const snapshot = document.orderedSnapshotValue(
      this.#revision,
      this.#page,
      this.#elements,
      this.#orders,
      this.#fontResources,
    );
    if (snapshot === null) return null;
    const { fontResources: _resources, ...header } = snapshot;
    return { ...header, ...snapshotTextResources(snapshot) };
  }
  public currentFontResources(): readonly NonNullable<InkSnapshotV1["fontResources"]>[number][] {
    return this.#fontResources;
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
    this.#fontResources = model.fontResources.map(canonicalFontResource);
    this.sampleEncodingCache.reconcileElements(model.elements);
    for (const id of this.#shapeCache.ids()) {
      if (!model.elements.has(id)) this.#shapeCache.remove(id);
    }
    this.#cache = cache;
    this.#elements = model.elements;
    this.#facts = model.facts;
    this.#connectionTargets = model.connectionTargets;
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
    const fonts = yield* prepareDeltaFontResourcesSteps(
      this.#fontResources,
      delta.fontResources,
      signal,
    );
    if (!fonts.ok) return fonts;
    if (this.#revision === null || delta.baseModelRevision !== this.#revision) {
      return codecFailure(
        "base-revision-mismatch",
        "Delta base revision does not match the model.",
      );
    }
    const prepared = yield* deltaValidation.prepareDocumentDeltaSteps(
      {
        currentElements: this.#elements,
        currentOrders: this.#orders,
        currentPage: this.#page!,
        delta,
      },
      nodesPerStep,
    );
    if (!prepared.ok) return prepared;
    const facts = yield* deltaValidation.validateDocumentDeltaSteps(
      {
        aggregate: this.#aggregateFacts,
        currentElements: this.#elements,
        currentFacts: this.#facts,
        connectionTargets: this.#connectionTargets,
        currentPage: this.#page!,
        pageChanged: delta.page !== undefined,
        prepared: prepared.value,
        runtimeStrokeBuffers: this.#runtimeStrokeBuffers,
      },
      nodesPerStep,
    );
    if (!facts.ok) return facts;
    try {
      yield* usedFontResourcesSteps(
        deltaTextElements(
          this.#elements,
          prepared.value.changed,
          prepared.value.removed,
          !retainsFontFaces(this.#fontResources, fonts.value),
        ),
        fonts.value,
      );
    } catch {
      return codecFailure("invalid-delta", "A required text font resource is unavailable.");
    }
    const ranks = yield* prepareSerializationRankUpdate(
      { currentOrders: this.#orders, nextOrders: prepared.value.orders, currentRanks: this.#ranks },
      nodesPerStep,
    );
    const changed = yield* canonicalizeSerializationElementsSteps(
      prepared.value.changed.values(),
      fonts.value,
      this.#runtimeStrokeBuffers,
      !ownsSamples,
      nodesPerStep,
    );
    yield;
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
    this.#fontResources = fonts.value;
    this.#revision = delta.modelRevision;
    this.#aggregateFacts = facts.value.aggregate;
    this.#connectionTargets = facts.value.connectionTargets;
    this.#derivedBoundsReuses += prepared.value.derivations.size;
    this.#incrementalValidationRuns += 1;
    this.#epoch += 1;
    return { ok: true, value: undefined };
  }
  public serialize(
    hasher: DocumentHashPort = SHA256_DOCUMENT_HASHER,
  ): DocumentCodecResult<SerializedInkbookDocument> {
    return serializeDocumentFragments({
      snapshot: this.currentSnapshot(),
      maximumBottom: this.#aggregateFacts.maximumBottom,
      backgroundCache: this.#backgroundCache,
      orders: this.#orders,
      element: (id) => this.#elements.get(id)!,
      fragment: (element) => this.#fragmentsFor(element),
      hasher,
    });
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
    this.#fontResources = [];
    this.#epoch += 1;
    this.#cache.clear();
    this.#shapeCache.clear();
    this.sampleEncodingCache.clear();
    this.#backgroundCache.clear();
    this.#elements.clear();
    this.#facts.clear();
    this.#connectionTargets.clear();
    this.#ranks.content.clear();
    this.#ranks.highlight.clear();
    this.#orders.content = [];
    this.#orders.highlight = [];
    this.#page = null;
    this.#revision = null;
    this.#runtimeStrokeBuffers = false;
    this.#aggregateFacts = incrementalValidation.emptyAggregateFacts();
  }
  #fragmentsFor(element: InkElementV1, cached = this.#cache.current(element)): ElementFragments {
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
  #fragmentsForSliced(
    element: InkElementV1,
    options: ChunkedOutputAssemblyOptions,
    maximumBytes = Infinity,
  ): ElementFragments | Promise<ElementFragments> {
    const cached = this.#cache.current(element);
    if (cached && cached.bytes <= maximumBytes) return this.#fragmentsFor(element, cached);
    const epoch = this.#epoch;
    const pending = this.#cache.resolveSliced({
      element,
      bottom: this.#facts.get(element.id)!.bottom,
      shapeCache: this.#shapeCache,
      sampleCache: this.sampleEncodingCache,
      assembly: options,
      maximumBytes,
      isCurrent: () => epoch === this.#epoch && this.#elements.get(element.id) === element,
    });
    return pending.then(({ fragments, built }) => {
      if (built) this.#fragmentBuilds += 1;
      else if (fragments.bytes <= maximumBytes) this.#fragmentHits += 1;
      return fragments;
    });
  }
}
