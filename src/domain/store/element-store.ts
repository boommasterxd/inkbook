import type { ArrangeAction } from "../commands/arrange";
import { renderBandOf, type RenderBand } from "../commands/render-bands";
import type { ResolvedShapeAnchor } from "../geometry/anchors";
import type { InkElementV1 } from "../schema/public";
import { SpatialQueryScratch, UniformSpatialIndex, type SpatialBounds } from "../spatial/index";
import { addConnectionReferences, assertResolvedConnections } from "./connections";
import { prepareCreatedRecords } from "./creation-planner";
import { DeltaBuilder } from "./delta-builder";
import { DocumentCapacity } from "./document-capacity";
import { createElementStoreBuilder, type ElementStoreBuilder } from "./element-store-builder";
import { ElementStoreRuntime } from "./element-store-runtime";
import { hasConnections } from "./element-comparison";
import { commitMutationDerivedState, type ElementMutationPlan } from "./element-mutation";
import { removeElements } from "./element-removal";
import { mutableElement } from "./immutability";
import { EMPTY_STORE_INSTRUMENTATION, type MutableStoreInstrumentation } from "./instrumentation";
import { normalizeElementInput } from "./input-normalization";
import { applyMutationRecordPatches } from "./mutation-record-patch";
import { assertCompleteBandOrder, ElementStoreOrdering } from "./order-operations";
import {
  prepareReplacementPlan,
  prepareReplacementPlanTimeSliced,
  type ReplacementPlan,
} from "./replacement-plan";
import { PreparedElementMutations } from "./prepared-element-mutations";
import type { PreparedReplacementState } from "./replacement-types";
import { assignRecordVersions, createInitialRecord, nextRecordVersion } from "./record-factory";
import {
  assertValidElement,
  prepareReplacementCandidates,
  type ReplacementCandidate,
  type ReplacementPlannerPorts,
} from "./replacement-planner";
import { commitReplacementPlan, planElementReplacement } from "./time-sliced-element-replacement";
import { materializeStoreSnapshot } from "./snapshot-materializer";
import { StoreOrderCursor } from "./order-cursor";
import { commitSynchronousReplacements } from "./synchronous-element-replacement";
import type { TimeSlicedStoreState } from "./time-sliced-store-creation";
import type {
  AppliedRemovalResult,
  CreateOptions,
  DeltaDomain,
  ElementMutation,
  ElementMutationCommitResult,
  ElementRecord,
  ElementStoreInstrumentation,
  ElementStoreMemoryUsage,
  ElementStyle,
  EndpointReference,
  MaterializedSnapshot,
  ElementRank,
  PreparedElementMutation,
  PreparedElementMutationResult,
  PreparedElementReplacement,
  PreparedElementReplacementResult,
  SnapshotMaterialization,
  StoreDelta,
  StoreDeltaListener,
  StoreSliceScheduler,
  TimeSlicedStoreResult,
} from "./types";

export class ElementStore {
  #bands: Record<RenderBand, string[]> = { content: [], highlight: [] };
  #capacity = new DocumentCapacity();
  #ranks = new Map<string, ElementRank>();
  #records = new Map<string, ElementRecord>();
  #reverseConnections = new Map<string, EndpointReference[]>();
  #spatialIndex = new UniformSpatialIndex<string>();
  #geometryVersion = 0;
  #instrumentation: MutableStoreInstrumentation = { ...EMPTY_STORE_INSTRUMENTATION };
  #mutationVersion = 0;
  #overflowCount = 0;
  #paintVersion = 0;
  readonly #ordering = new ElementStoreOrdering(() => ({
    bands: this.#bands,
    ranks: this.#ranks,
    records: this.#records,
  }));
  readonly #runtime = new ElementStoreRuntime();
  readonly #preparedElementReplacements = new WeakMap<
    PreparedElementReplacement,
    PreparedReplacementState
  >();
  readonly #preparedElementMutations = new PreparedElementMutations(
    () => ({
      capacity: this.#capacity,
      index: this.#spatialIndex,
      bands: this.#bands,
      geometryVersion: this.#geometryVersion,
      mutationVersion: this.#mutationVersion,
      paintVersion: this.#paintVersion,
      ranks: this.#ranks,
      records: this.#records,
      reverseConnections: this.#reverseConnections,
    }),
    () => this.#mutationVersion,
    (plan) => this.#adoptElementMutation(plan),
  );

  public constructor(elements: readonly InkElementV1[] = []) {
    const records = new Map<string, ElementRecord>();
    for (const element of elements) {
      assertValidElement(element);
      if (records.has(element.id)) throw new RangeError(`Duplicate element ID: ${element.id}`);
      records.set(element.id, createInitialRecord(element));
    }
    const lookup = (id: string) => records.get(id)?.element;
    for (const record of records.values()) this.#capacity.addInitial(record);
    this.#spatialIndex.insertMany(
      [...records.values()].map(({ bounds, element }) => ({ bounds, id: element.id })),
    );
    for (const record of records.values()) {
      assertResolvedConnections(record.element, lookup);
      this.#records.set(record.element.id, record);
      addConnectionReferences(this.#reverseConnections, record.element);
      const band = renderBandOf(record.element);
      this.#ranks.set(record.element.id, { band, rank: this.#bands[band].length });
      this.#bands[band].push(record.element.id);
    }
    this.#runtime.initializeMemory(records.values());
    this.#overflowCount = this.#spatialIndex.overflowCount;
  }
  public static async createTimeSliced(
    elements: readonly InkElementV1[],
    scheduler: StoreSliceScheduler,
  ): Promise<ElementStore | null> {
    const builder = this.createBuilder(scheduler);
    if ((await builder.append(elements)) === "cancelled") return null;
    return builder.finalize();
  }
  public static createBuilder(scheduler: StoreSliceScheduler): ElementStoreBuilder<ElementStore> {
    return createElementStoreBuilder(scheduler, (state) => this.adoptTimeSlicedState(state));
  }
  public static adoptTimeSlicedState(state: TimeSlicedStoreState): ElementStore {
    const store = new ElementStore();
    store.#records = state.records;
    store.#spatialIndex = state.index;
    store.#capacity = state.capacity;
    store.#overflowCount = state.overflowCount;
    for (const band of ["highlight", "content"] as const)
      store.#bands[band].push(...state.bands[band]);
    for (const [id, rank] of state.ranks) store.#ranks.set(id, { ...rank });
    for (const [id, references] of state.reverseConnections)
      store.#reverseConnections.set(id, references);
    store.#instrumentation.hydrationElementVisits = state.elementCount * 2;
    store.#instrumentation.hydrationYields = state.yields;
    store.#runtime.initializeMemory(state.records.values());
    return store;
  }
  public get size(): number {
    return this.#records.size;
  }
  public get instrumentation(): ElementStoreInstrumentation {
    return this.#runtime.instrumentation(this.#instrumentation);
  }
  public get(id: string): ElementRecord | undefined {
    return this.#records.get(id);
  }
  public getRank(id: string): Readonly<ElementRank> | undefined {
    const rank = this.#ranks.get(id);
    return rank === undefined ? undefined : Object.freeze({ ...rank });
  }
  public getSemanticAnchors(id: string): readonly ResolvedShapeAnchor[] | null {
    return this.#runtime.semanticAnchors(this.#records.get(id));
  }
  public pressureGeometry(id: string, version: number) {
    return this.#runtime.pressureGeometry(id, version, (key) => this.#records.get(key));
  }
  public readonly preparedPressurePaths = (ids?: ReadonlySet<string>) =>
    this.#runtime.preparedPressurePaths((id) => this.#records.get(id), ids);
  public readonly releasePreparedPressureGeometry = () => this.#runtime.releasePressureGeometry();
  public readonly activeDocumentMemoryUsage = (): ElementStoreMemoryUsage =>
    this.#runtime.memoryUsage();
  public readonly subscribeMemoryUsage = (listener: () => void): (() => void) =>
    this.#runtime.subscribeMemoryUsage(listener);
  public setActiveDocumentMemoryPressure(active: boolean): void {
    this.#runtime.setActiveDocumentMemoryPressure(active);
  }
  public subscribe(listener: StoreDeltaListener): () => void {
    return this.#runtime.subscribe(listener);
  }
  public create(
    values: InkElementV1 | readonly InkElementV1[],
    options: CreateOptions = {},
  ): StoreDelta | null {
    const elements = normalizeElementInput(values);
    if (elements.length === 0) return null;
    const prepared = prepareCreatedRecords(elements, {
      getExisting: (id) => this.#records.get(id)?.element,
      hasExisting: (id) => this.#records.has(id),
    });
    const geometryVersion = nextRecordVersion(this.#geometryVersion, "geometryVersion");
    const paintVersion = nextRecordVersion(this.#paintVersion, "paintVersion");
    const capacityPatch = this.#capacity.prepare([], prepared);
    this.#spatialIndex.insertMany(
      prepared.map(({ bounds, element }) => ({ bounds, id: element.id })),
    );
    this.#capacity.commit(capacityPatch);
    const delta = new DeltaBuilder();
    for (const preparedRecord of prepared) {
      const record = assignRecordVersions(preparedRecord, geometryVersion, paintVersion);
      this.#records.set(record.element.id, record);
      addConnectionReferences(this.#reverseConnections, record.element);
      this.#ordering.insert(record.element, options.placement ?? "front", delta);
      const domains: DeltaDomain[] = ["geometry", "paint", "order", "visibility"];
      if (hasConnections(record.element)) domains.push("connection");
      delta.add(record.element.id, null, record, domains);
    }
    this.#geometryVersion = geometryVersion;
    this.#paintVersion = paintVersion;
    this.#overflowCount = this.#spatialIndex.overflowCount;
    return this.#publish(delta.build(geometryVersion, paintVersion));
  }
  public replace(id: string, replacement: InkElementV1): StoreDelta | null {
    if (id !== replacement.id) throw new RangeError("Replacement ID must match the requested ID.");
    return this.replaceMany([replacement]);
  }
  public replaceMany(replacements: readonly InkElementV1[]): StoreDelta | null {
    if (replacements.length === 0) return null;
    const candidates = this.#prepareReplacementCandidates(replacements);
    if (candidates.length === 0) return null;
    return this.#commitReplacements(candidates);
  }
  public planReplacements(replacements: readonly InkElementV1[]): ReplacementPlan | null {
    if (replacements.length === 0) return null;
    const prepared = prepareReplacementPlan(replacements, this.#replacementPorts());
    return prepared.elements.length === 0 ? null : prepared;
  }

  public async planReplacementsTimeSliced(
    replacements: readonly InkElementV1[],
    scheduler: StoreSliceScheduler,
  ): Promise<ReplacementPlan | "cancelled" | null> {
    if (replacements.length === 0) return null;
    const mutationVersion = this.#mutationVersion;
    const prepared = await prepareReplacementPlanTimeSliced(
      replacements,
      this.#replacementPorts(),
      {
        isCancelled: () =>
          this.#mutationVersion !== mutationVersion || (scheduler.isCancelled?.() ?? false),
        shouldYield: scheduler.shouldYield,
        yieldControl: scheduler.yieldControl,
      },
    );
    if (prepared === "cancelled" || this.#mutationVersion !== mutationVersion) return "cancelled";
    return prepared.elements.length === 0 ? null : prepared;
  }

  public async prepareElementReplacement(
    replacements: readonly InkElementV1[],
    scheduler: StoreSliceScheduler,
  ): Promise<PreparedElementReplacementResult> {
    if (replacements.length === 0) return { status: "noop", token: null };
    const mutationVersion = this.#mutationVersion;
    const isCancelled = () =>
      this.#mutationVersion !== mutationVersion || (scheduler.isCancelled?.() ?? false);
    const plan = await planElementReplacement(
      {
        capacity: this.#capacity,
        geometryVersion: this.#geometryVersion,
        paintVersion: this.#paintVersion,
        records: this.#records,
        reverseConnections: this.#reverseConnections,
        spatialIndex: this.#spatialIndex,
      },
      replacements,
      {
        isCancelled,
        shouldYield: scheduler.shouldYield,
        yieldControl: scheduler.yieldControl,
      },
    );
    if (plan === "cancelled" || this.#mutationVersion !== mutationVersion) {
      return { status: "cancelled", token: null };
    }
    if (plan === null) return { status: "noop", token: null };
    const token = Object.freeze({}) as PreparedElementReplacement;
    this.#preparedElementReplacements.set(token, { isCancelled, mutationVersion, plan });
    this.#instrumentation.timeSlicedIndexVisits += plan.indexVisitCount;
    this.#instrumentation.timeSlicedReplacementYields += plan.yields;
    return { status: "prepared", token };
  }

  public commitPreparedElementReplacement(
    token: PreparedElementReplacement,
  ): TimeSlicedStoreResult {
    const prepared = this.#preparedElementReplacements.get(token);
    this.#preparedElementReplacements.delete(token);
    if (
      prepared === undefined ||
      prepared.isCancelled() ||
      this.#mutationVersion !== prepared.mutationVersion
    ) {
      return { delta: null, status: "cancelled" };
    }
    const { plan } = prepared;
    commitReplacementPlan(
      this.#capacity,
      this.#records,
      this.#reverseConnections,
      this.#spatialIndex,
      plan,
    );
    this.#overflowCount = this.#spatialIndex.overflowCount;
    this.#geometryVersion = plan.geometryVersion;
    this.#paintVersion = plan.paintVersion;
    this.#instrumentation.recordReplacements += plan.replacementCount;
    return { delta: this.#publish(plan.delta), status: "committed" };
  }
  public prepareElementMutation(
    mutation: ElementMutation,
    scheduler: StoreSliceScheduler,
    replay?: import("./types").AppliedElementMutation,
  ): Promise<PreparedElementMutationResult> {
    return this.#preparedElementMutations.prepare(mutation, scheduler, replay);
  }
  public readonly createRemovalMutationTimeSliced =
    this.#preparedElementMutations.createRemovalMutationTimeSliced.bind(
      this.#preparedElementMutations,
    );
  public commitPreparedElementMutation(
    token: PreparedElementMutation,
  ): ElementMutationCommitResult {
    return this.#preparedElementMutations.commit(token);
  }
  #adoptElementMutation(plan: ElementMutationPlan): ElementMutationCommitResult {
    commitMutationDerivedState(this.#capacity, this.#reverseConnections, plan);
    applyMutationRecordPatches(this.#records, this.#ranks, plan);
    this.#overflowCount = this.#spatialIndex.overflowCount;
    this.#geometryVersion = plan.delta.geometryVersion;
    this.#paintVersion = plan.delta.paintVersion;
    this.#bands = plan.bands;
    return { delta: this.#publish(plan.delta), status: "committed", transition: plan.applied };
  }

  public updateStyle(id: string, style: ElementStyle): StoreDelta | null {
    const current = this.#requireRecord(id);
    const replacement = mutableElement(current.element);
    replacement.style = style;
    return this.replace(id, replacement);
  }

  public remove(ids: ReadonlySet<string> | readonly string[]): StoreDelta | null {
    const result = removeElements(
      {
        bands: this.#bands,
        capacity: this.#capacity,
        geometryVersion: this.#geometryVersion,
        instrumentation: this.#instrumentation,
        overflowCount: this.#overflowCount,
        paintVersion: this.#paintVersion,
        ranks: this.#ranks,
        records: this.#records,
        reverseConnections: this.#reverseConnections,
        spatialIndex: this.#spatialIndex,
      },
      ids,
    );
    if (result === null) return null;
    this.#geometryVersion = result.geometryVersion;
    this.#overflowCount += result.overflowDelta;
    return this.#publish(result.delta);
  }

  public removeWithHistory(
    ids: ReadonlySet<string> | readonly string[],
  ): AppliedRemovalResult | null {
    const before = {
      content: [...this.#bands.content],
      highlight: [...this.#bands.highlight],
    };
    const delta = this.remove(ids);
    if (delta === null) return null;
    const transition = this.#preparedElementMutations.retainRemoval(delta, before, this.#bands);
    return Object.freeze({ delta, transition });
  }

  public arrange(selectedIds: ReadonlySet<string>, action: ArrangeAction): StoreDelta | null {
    const delta = new DeltaBuilder();
    for (const band of ["highlight", "content"] as const) {
      const ids = this.#bands[band];
      this.#ordering.arrange(ids, selectedIds, action);
      this.#instrumentation.bandScans += 1;
      this.#ordering.refresh(band, 0, delta);
    }
    return this.#publish(delta.build(this.#geometryVersion, this.#paintVersion));
  }

  public reorderBands(
    orderedIds: Readonly<Record<RenderBand, readonly string[]>>,
  ): StoreDelta | null {
    for (const band of ["highlight", "content"] as const) {
      assertCompleteBandOrder(
        this.#bands[band],
        band,
        orderedIds[band],
        (id) => this.#ranks.get(id)?.band,
      );
    }
    const delta = new DeltaBuilder();
    for (const band of ["highlight", "content"] as const) {
      const ids = this.#bands[band];
      for (let index = 0; index < ids.length; index += 1) ids[index] = orderedIds[band][index]!;
      this.#instrumentation.bandScans += 1;
      this.#ordering.refresh(band, 0, delta);
    }
    return this.#publish(delta.build(this.#geometryVersion, this.#paintVersion));
  }
  public beginOrder(): StoreOrderCursor {
    const bands = () => this.#bands;
    return new StoreOrderCursor(bands, () => this.#mutationVersion);
  }
  public beginQuery(bounds: SpatialBounds): ReturnType<UniformSpatialIndex<string>["beginQuery"]> {
    return this.#spatialIndex.beginQuery(bounds);
  }

  public query(bounds: SpatialBounds, scratch: SpatialQueryScratch<string>): number {
    return this.#spatialIndex.query(bounds, scratch);
  }
  public getMaximumBottom(): number | undefined {
    return this.#spatialIndex.getMaximumBottom();
  }
  public visitDependents(targetId: string, visitor: (reference: EndpointReference) => void): void {
    const references = this.#reverseConnections.get(targetId);
    if (references === undefined) return;
    for (const reference of references) {
      this.#instrumentation.reverseDependencyVisits += 1;
      visitor(reference);
    }
  }
  public countReverseDependencies(targetIds: readonly string[], limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError("The reverse-dependency count limit must be a non-negative integer.");
    }
    let count = 0;
    for (const targetId of targetIds) {
      count += this.#reverseConnections.get(targetId)?.length ?? 0;
      if (count > limit) return limit + 1;
    }
    return count;
  }
  public materializeBandOrder(band: RenderBand): readonly string[] {
    this.#instrumentation.bandScans += 1;
    return Object.freeze([...this.#bands[band]]);
  }
  public materializeSnapshot(input: SnapshotMaterialization): MaterializedSnapshot {
    this.#instrumentation.snapshotMaterializations += 1;
    this.#instrumentation.fullStoreScans += 1;
    return materializeStoreSnapshot(this.#bands, this.#records, input);
  }
  public resetInstrumentation(): void {
    this.#instrumentation = { ...EMPTY_STORE_INSTRUMENTATION };
    this.#runtime.resetStatistics();
  }
  #commitReplacements(candidates: readonly ReplacementCandidate[]): StoreDelta {
    const result = commitSynchronousReplacements(
      {
        capacity: this.#capacity,
        geometryVersion: this.#geometryVersion,
        paintVersion: this.#paintVersion,
        records: this.#records,
        reverseConnections: this.#reverseConnections,
        spatialIndex: this.#spatialIndex,
      },
      candidates,
    );
    this.#overflowCount = result.overflowCount;
    this.#geometryVersion = result.geometryVersion;
    this.#paintVersion = result.paintVersion;
    this.#instrumentation.recordReplacements += result.replacementCount;
    return this.#publish(result.delta)!;
  }
  #prepareReplacementCandidates(replacements: readonly InkElementV1[]): ReplacementCandidate[] {
    return prepareReplacementCandidates(replacements, this.#replacementPorts());
  }
  #replacementPorts(): ReplacementPlannerPorts {
    return {
      getRecord: (id) => this.#requireRecord(id),
      getReferences: (targetId) => this.#reverseConnections.get(targetId),
      onReverseVisit: () => {
        this.#instrumentation.reverseDependencyVisits += 1;
      },
    };
  }
  #requireRecord(id: string): ElementRecord {
    const record = this.#records.get(id);
    if (record === undefined) throw new RangeError(`Unknown element ID: ${id}`);
    return record;
  }
  #publish(delta: StoreDelta | null): StoreDelta | null {
    if (delta === null) return null;
    this.#mutationVersion += 1;
    return this.#runtime.publish(delta, this.#instrumentation);
  }
}
