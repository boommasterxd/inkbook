import { StrokeShapeCache } from "./stroke-shape-cache";
import type { SvgPathPart } from "../../domain/geometry/svg-path-part";
import { StrokeSampleEncodingCache } from "./stroke-sample-encoding-cache";
import { pressureShapeKey } from "./prepared-pressure-hints";
import { derivePageExtent } from "../../domain/geometry/public";
import {
  FILE_SCHEMA_LIMITS,
  validateInkSnapshotV1,
  type InkElementV1,
  type InkSnapshotV1,
  type PageV1,
  type SnapshotValidationDerivations,
} from "../../domain/schema/public";
import { validateRuntimeInkSnapshotV1 } from "../../domain/schema/snapshot-validation";
import { serializeSvgNumber } from "../documents/svg-number";
import { BackgroundFragmentCache } from "./background";
import { canonicalElement, canonicalPage, canonicalSnapshot } from "./canonical-snapshot";
import {
  canonicalMetadataFragmentsSha256,
  metadataPrefix as canonicalMetadataPrefix,
} from "./canonical-metadata";
import { codecFailure, invalidSnapshot } from "./codec-failure";
import {
  assembleAndHashChunkedOutput,
  type ChunkedOutputAssemblyOptions,
  ChunkedOutputLimitError,
} from "./chunked-output-assembler";
import { documentFragments, envelope, snapshotMetadata, snapshotValue } from "./document-assembly";
import {
  buildElementFragments,
  elementRenderBand,
  type ElementFragments,
  type RenderBand,
} from "./element-fragments";
import { ElementFragmentCache } from "./element-fragment-cache";
import { prepareDocumentDelta, validateDocumentDelta } from "./incremental-document-delta";
import type { EncodedByteBudget } from "./encoded-byte-budget";
import * as incrementalValidation from "./incremental-validation";
import type {
  Background,
  DocumentSerializationDelta,
  ElementAssembly,
  FragmentSerializerInstrumentation,
  FragmentAssembly,
} from "./incremental-document-serializer-types";
import { prepareSerialization } from "./serialization-budgets";
import { collectOrderedElementFragments } from "./ordered-element-fragments";
import { SHA256_DOCUMENT_HASHER, type DocumentHashPort } from "./sha256";
import { serializeRuntimeSnapshotToUtf8 } from "./streaming-runtime-export";
import type { DocumentCodecResult, SerializedInkbookDocument } from "./types";
export class IncrementalDocumentSerializer {
  readonly #cache = new ElementFragmentCache();
  readonly #shapeCache = new StrokeShapeCache();
  readonly #elements = new Map<string, InkElementV1>();
  public readonly sampleEncodingCache = new StrokeSampleEncodingCache((stroke) => {
    const current = this.#elements.get(stroke.id);
    return (
      this.#runtimeStrokeBuffers &&
      current?.kind === "stroke" &&
      current.points === stroke.points &&
      stroke.points instanceof Float64Array
    );
  });
  readonly #facts = new Map<string, incrementalValidation.ElementFacts>();
  readonly #orders: Record<RenderBand, string[]> = { content: [], highlight: [] };
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
    if (this.#page === null || this.#revision === null) return null;
    const ids = [...this.#orders.highlight, ...this.#orders.content];
    const elements = ids.map((id) => this.#elements.get(id)!);
    return snapshotValue(this.#revision, this.#page, elements);
  }
  public currentRevision(): number | null {
    return this.#revision;
  }
  public currentPage(): PageV1 | null {
    return this.#page === null ? null : canonicalPage(this.#page);
  }
  public seedPreparedPressurePath(id: string, d: string, shapeKey: string): boolean {
    const element = this.#elements.get(id);
    if (
      element?.kind !== "stroke" ||
      !element.style.pressureEnabled ||
      (element.offset !== undefined && (element.offset.x !== 0 || element.offset.y !== 0)) ||
      pressureShapeKey(element) !== shapeKey
    )
      return false;
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
    const element = this.#elements.get(id);
    if (element?.kind !== "stroke") return undefined;
    return this.#shapeCache.prepare(element, context);
  }
  public currentElementCount(): number {
    return this.#elements.size;
  }
  public currentAggregateFacts(): Readonly<incrementalValidation.AggregateFacts> | null {
    return this.#revision === null ? null : { ...this.#aggregateFacts };
  }
  public prewarmElement(id: string, maximumBytes: number): number | null {
    const element = this.#elements.get(id);
    if (element === undefined) return null;
    const cached = this.#cache.current(element);
    if (cached !== undefined) {
      this.#cache.touch(id);
      return 0;
    }
    const fragments = buildElementFragments(
      element,
      this.#facts.get(id)?.bottom,
      this.#shapeCache,
      this.sampleEncodingCache,
    );
    if (fragments.bytes > maximumBytes) return null;
    this.#fragmentBuilds += 1;
    this.#cache.replace(id, fragments);
    return fragments.bytes;
  }
  public prewarmElementAt(index: number, maximumBytes: number): number | null {
    const highlight = this.#orders.highlight;
    const id =
      index < highlight.length ? highlight[index] : this.#orders.content[index - highlight.length];
    return id === undefined ? null : this.prewarmElement(id, maximumBytes);
  }
  public reset(snapshot: InkSnapshotV1): DocumentCodecResult<void> {
    return this.#reset(snapshot, false);
  }
  public resetRuntime(snapshot: InkSnapshotV1): DocumentCodecResult<void> {
    return this.#reset(snapshot, true);
  }
  public resetValidatedRuntime(
    snapshot: InkSnapshotV1,
    derivations: SnapshotValidationDerivations,
  ): DocumentCodecResult<void> {
    return this.#reset(snapshot, true, derivations);
  }
  #reset(
    snapshot: InkSnapshotV1,
    runtimeStrokeBuffers: boolean,
    validatedDerivations?: SnapshotValidationDerivations,
  ): DocumentCodecResult<void> {
    let validatedSnapshot = snapshot;
    let derivations = validatedDerivations;
    if (derivations === undefined) {
      const validation = runtimeStrokeBuffers
        ? validateRuntimeInkSnapshotV1(snapshot)
        : validateInkSnapshotV1(snapshot);
      this.#fullValidationRuns += 1;
      if (!validation.ok) return invalidSnapshot(validation.error);
      validatedSnapshot = validation.value;
      derivations = validation.derivations;
    }
    if (derivations.elements.length !== validatedSnapshot.elements.length) {
      return codecFailure("invalid-delta", "Validated element derivations are incomplete.");
    }
    const canonical = canonicalSnapshot(validatedSnapshot, runtimeStrokeBuffers);
    const nextFacts = new Map<string, incrementalValidation.ElementFacts>();
    try {
      for (let index = 0; index < canonical.elements.length; index += 1) {
        const element = canonical.elements[index]!;
        nextFacts.set(
          element.id,
          incrementalValidation.elementFacts(element, derivations.elements[index]),
        );
      }
    } catch {
      return codecFailure("invalid-delta", "Validated element derivation is inconsistent.");
    }
    this.#runtimeStrokeBuffers = runtimeStrokeBuffers;
    this.sampleEncodingCache.reconcile(canonical);
    const activeIds = new Set(canonical.elements.map(({ id }) => id));
    for (const id of this.#cache.ids()) {
      if (!activeIds.has(id)) this.#cache.remove(id);
    }
    for (const id of this.#shapeCache.ids()) {
      if (!activeIds.has(id)) this.#shapeCache.remove(id);
    }
    this.#elements.clear();
    this.#facts.clear();
    this.#orders.content = [];
    this.#orders.highlight = [];
    this.#page = canonical.page;
    this.#revision = canonical.revision;
    for (let index = 0; index < canonical.elements.length; index += 1) {
      const element = canonical.elements[index]!;
      this.#cache.adopt(element);
      this.#elements.set(element.id, element);
      this.#facts.set(element.id, nextFacts.get(element.id)!);
      this.#derivedBoundsReuses += 1;
      this.#orders[elementRenderBand(element)].push(element.id);
    }
    this.#aggregateFacts = incrementalValidation.aggregateElementFacts(this.#facts.values());
    return { ok: true, value: undefined };
  }
  public applyDelta(
    delta: DocumentSerializationDelta,
    deferredFragmentIds?: ReadonlySet<string>,
  ): DocumentCodecResult<void> {
    if (this.#revision === null || delta.baseModelRevision !== this.#revision) {
      return codecFailure(
        "base-revision-mismatch",
        "Delta base revision does not match the model.",
      );
    }
    const prepared = prepareDocumentDelta({
      currentElements: this.#elements,
      currentOrders: this.#orders,
      currentPage: this.#page!,
      delta,
    });
    if (!prepared.ok) return prepared;
    const facts = validateDocumentDelta({
      aggregate: this.#aggregateFacts,
      currentElements: this.#elements,
      currentFacts: this.#facts,
      currentPage: this.#page!,
      pageChanged: delta.page !== undefined,
      prepared: prepared.value,
      runtimeStrokeBuffers: this.#runtimeStrokeBuffers,
    });
    if (!facts.ok) return facts;
    for (const id of prepared.value.removed) {
      this.#facts.delete(id);
      this.#elements.delete(id);
      this.#cache.remove(id);
      this.sampleEncodingCache.remove(id);
      this.#shapeCache.retire(id);
    }
    for (const changedElement of prepared.value.changed.values()) {
      const element = canonicalElement(changedElement, this.#runtimeStrokeBuffers);
      this.#elements.set(element.id, element);
      this.#facts.set(element.id, facts.value.changed.get(element.id)!);
      if (deferredFragmentIds?.has(element.id)) {
        this.#cache.remove(element.id);
      } else {
        this.#cache.replace(
          element.id,
          buildElementFragments(
            element,
            facts.value.changed.get(element.id)!.bottom,
            this.#shapeCache,
            this.sampleEncodingCache,
          ),
        );
        this.#fragmentBuilds += 1;
      }
    }
    this.#orders.highlight = prepared.value.orders.highlight;
    this.#orders.content = prepared.value.orders.content;
    this.#page = canonicalPage(prepared.value.page);
    this.#revision = delta.modelRevision;
    this.#aggregateFacts = facts.value.aggregate;
    this.#derivedBoundsReuses += prepared.value.derivations.size;
    this.#incrementalValidationRuns += 1;
    return { ok: true, value: undefined };
  }
  public serialize(
    hasher: DocumentHashPort = SHA256_DOCUMENT_HASHER,
  ): DocumentCodecResult<SerializedInkbookDocument> {
    const prepared = prepareSerialization(
      this.#page,
      this.#revision,
      this.#aggregateFacts.maximumBottom,
      this.#resolveBackground.bind(this),
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
    const assembly = this.#assembleElements(outputBudget, metadataBudget);
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
    const prepared = prepareSerialization(
      this.#page,
      this.#revision,
      this.#aggregateFacts.maximumBottom,
      this.#resolveBackground.bind(this),
    );
    if (!prepared.ok) return prepared;
    const {
      background,
      lockedHeight,
      metadataPrefix,
      output: outputBudget,
      metadata: metadataBudget,
      page,
      revision,
    } = prepared.value;
    const assembly = this.#collectFragments(outputBudget, metadataBudget);
    if (!assembly.ok) return assembly;
    if (!metadataBudget.tryReserve(2)) return this.#outputLimitExceeded();
    const metadataBytes = metadataBudget.usedBytes;
    const metadataHash = canonicalMetadataFragmentsSha256(
      canonicalMetadataPrefix(revision, page),
      assembly.value.canonicalMetadata,
    );
    let assembled;
    try {
      assembled = await assembleAndHashChunkedOutput(
        documentFragments(
          revision,
          lockedHeight,
          metadataPrefix,
          metadataHash,
          assembly.value,
          background,
        ),
        { ...options, maximumBytes: FILE_SCHEMA_LIMITS.totalInputBytes },
      );
    } catch (error) {
      if (error instanceof ChunkedOutputLimitError) return this.#outputLimitExceeded();
      throw error;
    }
    const snapshot = snapshotValue(revision, page, assembly.value.elements);
    return {
      ok: true,
      value: {
        hash: assembled.hash,
        lockedHeight,
        metadataBytes,
        snapshot,
        snapshotHash: metadataHash,
        svg: assembled.output,
        totalBytes: assembled.totalBytes,
      },
    };
  }
  public serializeRuntimeChunked(
    options: ChunkedOutputAssemblyOptions,
  ): Promise<DocumentCodecResult<SerializedInkbookDocument<Uint8Array<ArrayBuffer>>>> {
    const snapshot = this.currentSnapshot();
    if (snapshot === null) {
      return Promise.resolve(
        codecFailure("invalid-delta", "Serializer has no initialized document model."),
      );
    }
    return serializeRuntimeSnapshotToUtf8(
      snapshot,
      options,
      (element) => this.#fragmentsFor(element),
      this.#backgroundCache,
    );
  }
  #resolveBackground(page: PageV1, maximumBottom: number | null): DocumentCodecResult<Background> {
    const extent = derivePageExtent(page, maximumBottom);
    const lockedHeight = Number(serializeSvgNumber(extent.lockedHeight));
    const background = this.#backgroundCache.resolve(
      page,
      lockedHeight,
      FILE_SCHEMA_LIMITS.totalInputBytes,
    );
    if (background === null) {
      return codecFailure(
        "static-output-limit-exceeded",
        "Generated background exceeds file limits.",
      );
    }
    return { ok: true, value: { background, lockedHeight } };
  }
  public clear(): void {
    this.#cache.clear();
    this.#shapeCache.clear();
    this.sampleEncodingCache.clear();
    this.#backgroundCache.clear();
    this.#elements.clear();
    this.#facts.clear();
    this.#orders.content = [];
    this.#orders.highlight = [];
    this.#page = null;
    this.#revision = null;
    this.#runtimeStrokeBuffers = false;
    this.#aggregateFacts = incrementalValidation.emptyAggregateFacts();
  }
  #assembleElements(
    outputBudget: EncodedByteBudget,
    metadataBudget: EncodedByteBudget,
  ): DocumentCodecResult<ElementAssembly> {
    const fragments = this.#collectFragments(outputBudget, metadataBudget);
    if (!fragments.ok) return fragments;
    if (!metadataBudget.tryReserve(2)) return this.#outputLimitExceeded();
    return {
      ok: true,
      value: {
        content: fragments.value.content.map(({ svg }) => svg).join(""),
        elements: fragments.value.elements,
        highlights: fragments.value.highlight.map(({ svg }) => svg).join(""),
        maximumBottom: fragments.value.maximumBottom,
        metadata: fragments.value.metadata,
        canonicalMetadata: fragments.value.canonicalMetadata,
      },
    };
  }
  #collectFragments(
    outputBudget: EncodedByteBudget,
    metadataBudget: EncodedByteBudget,
  ): DocumentCodecResult<FragmentAssembly> {
    return collectOrderedElementFragments({
      orders: this.#orders,
      element: (id) => this.#elements.get(id)!,
      fragment: (element) => this.#fragmentsFor(element),
      outputBudget,
      metadataBudget,
    });
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
  #outputLimitExceeded(): DocumentCodecResult<never> {
    return codecFailure("static-output-limit-exceeded", "Generated document exceeds file limits.");
  }
}
