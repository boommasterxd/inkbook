import { derivePageExtent } from "../../domain/geometry/public";
import {
  FILE_SCHEMA_LIMITS,
  validateInkElementV1,
  validateInkSnapshotV1,
  type InkElementV1,
  type InkSnapshotV1,
  type PageV1,
} from "../../domain/schema/public";
import { validateRuntimeInkElementV1 } from "../../domain/schema/element-validation";
import { validateRuntimeInkSnapshotV1 } from "../../domain/schema/snapshot-validation";
import { serializeSvgNumber } from "../documents/svg-number";
import { BackgroundFragmentCache } from "./background";
import { canonicalElement, canonicalPage, canonicalSnapshot } from "./canonical-snapshot";
import { canonicalMetadataSha256 } from "./canonical-metadata";
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
import { encodedByteLength, type EncodedByteBudget } from "./encoded-byte-budget";
import * as incrementalValidation from "./incremental-validation";
import type {
  Background,
  DocumentSerializationDelta,
  ElementAssembly,
  FragmentSerializerInstrumentation,
  FragmentAssembly,
  PreparedDelta,
} from "./incremental-document-serializer-types";
import { prepareSerialization } from "./serialization-budgets";
import { SHA256_DOCUMENT_HASHER, type DocumentHashPort } from "./sha256";
import { serializeRuntimeSnapshotToUtf8 } from "./streaming-runtime-export";
import type { DocumentCodecResult, SerializedInkbookDocument } from "./types";
const { connectionRelationsAffected } = incrementalValidation;
export class IncrementalDocumentSerializer {
  readonly #cache = new ElementFragmentCache();
  readonly #elements = new Map<string, InkElementV1>();
  readonly #facts = new Map<string, incrementalValidation.ElementFacts>();
  readonly #orders: Record<RenderBand, string[]> = { content: [], highlight: [] };
  readonly #backgroundCache = new BackgroundFragmentCache();
  #fragmentBuilds = 0;
  #fragmentHits = 0;
  #fullValidationRuns = 0;
  #incrementalValidationRuns = 0;
  #aggregateFacts = incrementalValidation.emptyAggregateFacts();
  #page: PageV1 | null = null;
  #revision: number | null = null;
  #runtimeStrokeBuffers = false;
  public get instrumentation(): FragmentSerializerInstrumentation {
    return {
      backgroundBuilds: this.#backgroundCache.builds,
      cacheBytes: this.#cache.retainedBytes,
      cacheElements: this.#cache.size,
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
  public prewarmElement(id: string, maximumBytes: number): number | null {
    const element = this.#elements.get(id);
    if (element === undefined) return null;
    const cached = this.#cache.current(element);
    if (cached !== undefined) {
      this.#cache.touch(id);
      return 0;
    }
    const fragments = buildElementFragments(element);
    if (fragments.bytes > maximumBytes) return null;
    this.#fragmentBuilds += 1;
    this.#cache.replace(id, fragments);
    return fragments.bytes;
  }
  public reset(snapshot: InkSnapshotV1): DocumentCodecResult<void> {
    return this.#reset(snapshot, false);
  }
  public resetRuntime(snapshot: InkSnapshotV1): DocumentCodecResult<void> {
    return this.#reset(snapshot, true);
  }
  #reset(snapshot: InkSnapshotV1, runtimeStrokeBuffers: boolean): DocumentCodecResult<void> {
    const validation = runtimeStrokeBuffers
      ? validateRuntimeInkSnapshotV1(snapshot)
      : validateInkSnapshotV1(snapshot);
    this.#fullValidationRuns += 1;
    if (!validation.ok) return invalidSnapshot(validation.error);
    const canonical = canonicalSnapshot(validation.value, runtimeStrokeBuffers);
    this.#runtimeStrokeBuffers = runtimeStrokeBuffers;
    const activeIds = new Set(canonical.elements.map(({ id }) => id));
    for (const id of this.#cache.ids()) {
      if (!activeIds.has(id)) this.#cache.remove(id);
    }
    this.#elements.clear();
    this.#facts.clear();
    this.#orders.content = [];
    this.#orders.highlight = [];
    this.#page = canonical.page;
    this.#revision = canonical.revision;
    for (const element of canonical.elements) {
      this.#cache.adopt(element);
      this.#elements.set(element.id, element);
      this.#facts.set(element.id, incrementalValidation.elementFacts(element));
      this.#orders[elementRenderBand(element)].push(element.id);
    }
    this.#aggregateFacts = incrementalValidation.aggregateElementFacts(this.#facts.values());
    return { ok: true, value: undefined };
  }
  public applyDelta(delta: DocumentSerializationDelta): DocumentCodecResult<void> {
    if (this.#revision === null || delta.baseModelRevision !== this.#revision) {
      return codecFailure(
        "base-revision-mismatch",
        "Delta base revision does not match the model.",
      );
    }
    const prepared = this.#prepareDelta(delta);
    if (!prepared.ok) return prepared;
    const facts = this.#validateDelta(prepared.value, delta.page !== undefined);
    if (!facts.ok) return facts;
    for (const id of prepared.value.removed) {
      this.#facts.delete(id);
      this.#elements.delete(id);
      this.#cache.remove(id);
    }
    for (const changedElement of prepared.value.changed.values()) {
      const element = canonicalElement(changedElement, this.#runtimeStrokeBuffers);
      this.#elements.set(element.id, element);
      this.#facts.set(element.id, facts.value.changed.get(element.id)!);
      this.#cache.replace(element.id, buildElementFragments(element));
      this.#fragmentBuilds += 1;
    }
    this.#orders.highlight = prepared.value.orders.highlight;
    this.#orders.content = prepared.value.orders.content;
    this.#page = canonicalPage(prepared.value.snapshot.page);
    this.#revision = delta.modelRevision;
    this.#aggregateFacts = facts.value.aggregate;
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
    const metadataHash = canonicalMetadataSha256(
      snapshotValue(revision, page, assembly.value.elements),
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
    return {
      ok: true,
      value: {
        hash: hasher.hash(svg),
        lockedHeight,
        metadataBytes,
        snapshot: {
          format: "inkbook",
          version: 1,
          revision,
          page,
          elements: assembly.value.elements,
        },
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
    const metadataHash = canonicalMetadataSha256(
      snapshotValue(revision, page, assembly.value.elements),
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
    return {
      ok: true,
      value: {
        hash: assembled.hash,
        lockedHeight,
        metadataBytes,
        snapshot: snapshotValue(revision, page, assembly.value.elements),
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
    return serializeRuntimeSnapshotToUtf8(snapshot, options, (element) =>
      this.#fragmentsFor(element),
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
  #prepareDelta(delta: DocumentSerializationDelta): DocumentCodecResult<PreparedDelta> {
    if (!Number.isSafeInteger(delta.modelRevision) || delta.modelRevision < 0) {
      return codecFailure(
        "invalid-delta",
        "Delta model revision must be a non-negative safe integer.",
      );
    }
    const removed = new Set(delta.removedIds ?? []);
    if (removed.size !== (delta.removedIds?.length ?? 0)) {
      return codecFailure("invalid-delta", "Removed element IDs must be unique.");
    }
    const changed = new Map<string, InkElementV1>();
    for (const element of delta.changedElements ?? []) {
      if (removed.has(element.id) || changed.has(element.id)) {
        return codecFailure(
          "invalid-delta",
          "Changed and removed element IDs must be disjoint and unique.",
        );
      }
      changed.set(element.id, element);
    }
    const orders = this.#prepareOrders(delta.orderChanges ?? {}, changed, removed);
    if (!orders.ok) return orders;
    const elements = [...orders.value.highlight, ...orders.value.content].map(
      (id) => changed.get(id) ?? this.#elements.get(id)!,
    );
    const page = delta.page === undefined ? this.#page! : delta.page;
    return {
      ok: true,
      value: {
        changed,
        orders: orders.value,
        removed,
        snapshot: { elements, format: "inkbook", page, revision: delta.modelRevision, version: 1 },
      },
    };
  }
  #validateDelta(
    prepared: PreparedDelta,
    pageChanged: boolean,
  ): DocumentCodecResult<incrementalValidation.ValidatedDeltaFacts> {
    const changedFacts = new Map<string, incrementalValidation.ElementFacts>();
    for (const element of prepared.changed.values()) {
      const validation = this.#runtimeStrokeBuffers
        ? validateRuntimeInkElementV1(element)
        : validateInkElementV1(element);
      if (!validation.ok) return invalidSnapshot(validation.error);
      changedFacts.set(element.id, incrementalValidation.elementFacts(element));
    }
    const aggregate = incrementalValidation.updateAggregateFacts(
      this.#aggregateFacts,
      this.#facts,
      changedFacts,
      prepared.removed,
    );
    const needsFullValidation =
      pageChanged ||
      connectionRelationsAffected(this.#elements.values(), prepared.changed, prepared.removed);
    if (needsFullValidation) {
      const validation = this.#runtimeStrokeBuffers
        ? validateRuntimeInkSnapshotV1(prepared.snapshot)
        : validateInkSnapshotV1(prepared.snapshot);
      this.#fullValidationRuns += 1;
      if (!validation.ok) return invalidSnapshot(validation.error);
      return { ok: true, value: { aggregate, changed: changedFacts } };
    }
    this.#incrementalValidationRuns += 1;
    const aggregateError = incrementalValidation.validateAggregateFacts(aggregate, this.#page!);
    return aggregateError === null
      ? { ok: true, value: { aggregate, changed: changedFacts } }
      : invalidSnapshot(aggregateError);
  }
  #prepareOrders(
    changes: Readonly<Partial<Record<RenderBand, readonly string[]>>>,
    changed: ReadonlyMap<string, InkElementV1>,
    removed: ReadonlySet<string>,
  ): DocumentCodecResult<Record<RenderBand, string[]>> {
    const available = new Map(this.#elements);
    for (const id of removed) available.delete(id);
    for (const [id, element] of changed) available.set(id, element);
    const orders = { content: [] as string[], highlight: [] as string[] };
    for (const band of ["highlight", "content"] as const) {
      orders[band] =
        changes[band] === undefined
          ? this.#orders[band].filter((id) => available.has(id))
          : [...changes[band]];
    }
    const ordered = [...orders.highlight, ...orders.content];
    if (ordered.length !== available.size || new Set(ordered).size !== ordered.length) {
      return codecFailure(
        "invalid-order",
        "Band order must contain every current element ID exactly once.",
      );
    }
    for (const band of ["highlight", "content"] as const) {
      for (const id of orders[band]) {
        const element = available.get(id);
        if (element === undefined || elementRenderBand(element) !== band) {
          return codecFailure(
            "invalid-order",
            "Band order contains an unknown or misclassified element ID.",
          );
        }
      }
    }
    return { ok: true, value: orders };
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
      },
    };
  }
  #collectFragments(
    outputBudget: EncodedByteBudget,
    metadataBudget: EncodedByteBudget,
  ): DocumentCodecResult<FragmentAssembly> {
    const elements: InkElementV1[] = [];
    const metadata: string[] = [];
    const fragments: Record<RenderBand, ElementFragments[]> = { content: [], highlight: [] };
    let maximumBottom: number | null = null;
    for (const band of ["highlight", "content"] as const) {
      for (const id of this.#orders[band]) {
        const element = this.#elements.get(id)!;
        const elementFragments = this.#fragmentsFor(element);
        const separatorBytes = metadata.length === 0 ? 0 : encodedByteLength(",");
        if (
          !metadataBudget.tryReserve(
            encodedByteLength(elementFragments.metadata) + separatorBytes,
          ) ||
          !outputBudget.tryReserve(elementFragments.bytes + separatorBytes)
        ) {
          return this.#outputLimitExceeded();
        }
        elements.push(element);
        metadata.push(elementFragments.metadata);
        fragments[band].push(elementFragments);
        maximumBottom = Math.max(maximumBottom ?? 0, elementFragments.bottom);
      }
    }
    return {
      ok: true,
      value: {
        content: fragments.content,
        elements,
        highlight: fragments.highlight,
        maximumBottom,
        metadata,
      },
    };
  }
  #fragmentsFor(element: InkElementV1): ElementFragments {
    const cached = this.#cache.current(element);
    if (cached !== undefined) {
      this.#fragmentHits += 1;
      this.#cache.touch(element.id);
      return cached;
    }
    const fragments = buildElementFragments(element);
    this.#fragmentBuilds += 1;
    this.#cache.retainIfSpace(element.id, fragments);
    return fragments;
  }
  #outputLimitExceeded(): DocumentCodecResult<never> {
    return codecFailure("static-output-limit-exceeded", "Generated document exceeds file limits.");
  }
}
