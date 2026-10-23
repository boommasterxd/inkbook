import type { ArrangeAction } from "../commands/arrange";
import { renderBandOf, type RenderBand } from "../commands/render-bands";
import type { ResolvedShapeAnchor } from "../geometry/anchors";
import type { InkElementV1 } from "../schema/public";
import { SpatialQueryScratch, UniformSpatialIndex, type SpatialBounds } from "../spatial/index";
import { addConnectionReferences, assertResolvedConnections } from "./records/connections";
import { prepareCreatedRecords } from "./records/creation-planner";
import { DeltaBuilder } from "./delta-builder";
import { DocumentCapacity } from "./records/document-capacity";
import { createElementStoreBuilder, type ElementStoreBuilder } from "./element-store-builder";
import { ElementStoreRuntime } from "./element-store-runtime";
import { hasConnections } from "./records/element-comparison";
import { commitMutationDerivedState, type ElementMutationPlan } from "./mutations/element-mutation";
import { removeElements } from "./mutations/element-removal";
import { mutableElement } from "./records/immutability";
import { mutableBand, type StoreBands } from "./mutations/band-snapshots";
import { EMPTY_STORE_INSTRUMENTATION, type MutableStoreInstrumentation } from "./instrumentation";
import { normalizeElementInput } from "./records/input-normalization";
import { applyMutationRecordPatches } from "./mutations/mutation-record-patch";
import { assertCompleteBandOrder, ElementStoreOrdering } from "./mutations/order-operations";
import {
  prepareReplacementPlanTimeSliced,
  type ReplacementPlan,
} from "./replacements/replacement-plan";
import { PreparedElementMutations } from "./mutations/prepared-element-mutations";
import { PreparedElementReplacements } from "./replacements/prepared-element-replacements";
import type { ElementReplacementPlan } from "./replacements/replacement-types";
import { ReplacementHistory } from "./replacements/replacement-history";
import {
  assignRecordVersions,
  createInitialRecord,
  nextRecordVersion,
} from "./records/record-factory";
import {
  assertValidElement,
  prepareReplacementCandidates,
  type ReplacementCandidate,
  type ReplacementPlannerPorts,
} from "./replacements/replacement-planner";
import { commitReplacementPlan } from "./replacements/time-sliced-element-replacement";
import { materializeStoreSnapshot } from "./records/snapshot-materializer";
import { StoreOrderCursor } from "./mutations/order-cursor";
import { commitSynchronousReplacements } from "./replacements/synchronous-element-replacement";
import { SynchronousReplacementPlans } from "./replacements/synchronous-replacement-plans";
import type { TimeSlicedStoreState } from "./time-sliced-store-creation";
import type * as Store from "./types";

export class ElementStore {
  #bands: StoreBands = { content: [], highlight: [] };
  #capacity = new DocumentCapacity();
  #ranks = new Map<string, Store.ElementRank>();
  #records = new Map<string, Store.ElementRecord>();
  #reverseConnections = new Map<string, Store.EndpointReference[]>();
  #spatialIndex = new UniformSpatialIndex<string>();
  #geometryVersion = 0;
  #instrumentation: MutableStoreInstrumentation = { ...EMPTY_STORE_INSTRUMENTATION };
  #mutationVersion = 0;
  #overflowCount = 0;
  #paintVersion = 0;
  readonly #plannedReplacements = new SynchronousReplacementPlans(
    () => this.#replacementPorts(),
    () => this.#mutationVersion,
  );
  readonly #ordering = new ElementStoreOrdering(() => ({
    bands: this.#bands,
    ranks: this.#ranks,
    records: this.#records,
  }));
  readonly #runtime = new ElementStoreRuntime();
  readonly #replacementHistory = new ReplacementHistory();
  readonly #preparedElementReplacements = new PreparedElementReplacements(
    () => ({
      capacity: this.#capacity,
      geometryVersion: this.#geometryVersion,
      history: this.#replacementHistory,
      mutationVersion: this.#mutationVersion,
      paintVersion: this.#paintVersion,
      records: this.#records,
      reverseConnections: this.#reverseConnections,
      spatialIndex: this.#spatialIndex,
    }),
    () => this.#mutationVersion,
    (plan) => {
      this.#instrumentation.timeSlicedIndexVisits += plan.indexVisitCount;
      this.#instrumentation.timeSlicedReplacementYields += plan.yields;
    },
    (plan) => this.#adoptElementReplacement(plan),
  );
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
    const records = new Map<string, Store.ElementRecord>();
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
      mutableBand(this.#bands, band).push(record.element.id);
    }
    this.#runtime.initializeMemory(records.values());
    this.#overflowCount = this.#spatialIndex.overflowCount;
  }
  public static async createTimeSliced(
    elements: readonly InkElementV1[],
    scheduler: Store.StoreSliceScheduler,
  ): Promise<ElementStore | null> {
    const builder = this.createBuilder(scheduler);
    if ((await builder.append(elements)) === "cancelled") return null;
    return builder.finalize();
  }
  public static createBuilder(
    scheduler: Store.StoreSliceScheduler,
  ): ElementStoreBuilder<ElementStore> {
    return createElementStoreBuilder(scheduler, (state) => this.adoptTimeSlicedState(state));
  }
  public static adoptTimeSlicedState(state: TimeSlicedStoreState): ElementStore {
    const store = new ElementStore();
    store.#records = state.records;
    store.#spatialIndex = state.index;
    store.#capacity = state.capacity;
    store.#overflowCount = state.overflowCount;
    for (const band of ["highlight", "content"] as const)
      mutableBand(store.#bands, band).push(...state.bands[band]);
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
  public get instrumentation(): Store.ElementStoreInstrumentation {
    return this.#runtime.instrumentation(this.#instrumentation);
  }
  public get(id: string): Store.ElementRecord | undefined {
    return this.#records.get(id);
  }
  public getRank(id: string): Readonly<Store.ElementRank> | undefined {
    const rank = this.#ranks.get(id);
    return rank === undefined ? undefined : Object.freeze({ ...rank });
  }
  public bandSize(band: RenderBand): number {
    return this.#bands[band].length;
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
  public readonly activeDocumentMemoryUsage = (): Store.ElementStoreMemoryUsage =>
    this.#runtime.memoryUsage();
  public readonly subscribeMemoryUsage = (listener: () => void): (() => void) =>
    this.#runtime.subscribeMemoryUsage(listener);
  public setActiveDocumentMemoryPressure(active: boolean): void {
    this.#runtime.setActiveDocumentMemoryPressure(active);
  }
  public subscribe(listener: Store.StoreDeltaListener): () => void {
    return this.#runtime.subscribe(listener);
  }
  public create(
    values: InkElementV1 | readonly InkElementV1[],
    options: Store.CreateOptions = {},
  ): Store.StoreDelta | null {
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
      const domains: Store.DeltaDomain[] = ["geometry", "paint", "order", "visibility"];
      if (hasConnections(record.element)) domains.push("connection");
      delta.add(record.element.id, null, record, domains);
    }
    this.#geometryVersion = geometryVersion;
    this.#paintVersion = paintVersion;
    this.#overflowCount = this.#spatialIndex.overflowCount;
    return this.#publish(delta.build(geometryVersion, paintVersion));
  }
  public replace(id: string, replacement: InkElementV1): Store.StoreDelta | null {
    if (id !== replacement.id) throw new RangeError("Replacement ID must match the requested ID.");
    return this.replaceMany([replacement]);
  }
  public replaceMany(
    replacements: readonly InkElementV1[],
    capture?: (history: Store.ElementReplacementHistoryData) => void,
  ): Store.StoreDelta | null {
    if (replacements.length === 0) return null;
    const candidates =
      this.#plannedReplacements.consume(replacements) ??
      prepareReplacementCandidates(replacements, this.#replacementPorts());
    if (candidates.length === 0) return null;
    return this.#commitReplacements(candidates, capture);
  }
  public readonly planReplacements = this.#plannedReplacements.plan.bind(this.#plannedReplacements);

  public async planReplacementsTimeSliced(
    replacements: readonly InkElementV1[],
    scheduler: Store.StoreSliceScheduler,
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

  public readonly prepareElementReplacement = this.#preparedElementReplacements.prepare.bind(
    this.#preparedElementReplacements,
  );
  public readonly commitPreparedElementReplacement = this.#preparedElementReplacements.commit.bind(
    this.#preparedElementReplacements,
  );
  #adoptElementReplacement(plan: ElementReplacementPlan): Store.ElementReplacementCommitResult {
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
    return { delta: this.#publish(plan.delta), history: plan.history, status: "committed" };
  }
  public readonly prepareElementMutation = this.#preparedElementMutations.prepare.bind(
    this.#preparedElementMutations,
  );
  public readonly prepareElementRemoval = this.#preparedElementMutations.prepareElementRemoval.bind(
    this.#preparedElementMutations,
  );
  public readonly createRemovalMutationTimeSliced =
    this.#preparedElementMutations.createRemovalMutationTimeSliced.bind(
      this.#preparedElementMutations,
    );
  public readonly prepareHistoryReplay = this.#preparedElementMutations.prepareHistoryReplay.bind(
    this.#preparedElementMutations,
  );
  public readonly prepareElementArrangement =
    this.#preparedElementMutations.prepareArrangement.bind(this.#preparedElementMutations);
  public readonly prepareElementAppend = this.#preparedElementMutations.prepareAppend.bind(
    this.#preparedElementMutations,
  );
  public readonly commitPreparedElementMutation = this.#preparedElementMutations.commit.bind(
    this.#preparedElementMutations,
  );
  #adoptElementMutation(plan: ElementMutationPlan): Store.ElementMutationCommitResult {
    commitMutationDerivedState(this.#capacity, this.#reverseConnections, plan);
    this.#ranks = applyMutationRecordPatches(this.#records, this.#ranks, plan);
    this.#overflowCount = this.#spatialIndex.overflowCount;
    this.#geometryVersion = plan.delta.geometryVersion;
    this.#paintVersion = plan.delta.paintVersion;
    this.#bands = plan.bands;
    return {
      delta: this.#publish(plan.delta, plan),
      status: "committed",
      transition: plan.applied,
    };
  }
  public updateStyle(id: string, style: Store.ElementStyle): Store.StoreDelta | null {
    const current = this.#requireRecord(id);
    const replacement = mutableElement(current.element);
    replacement.style = style;
    return this.replace(id, replacement);
  }

  public remove(ids: ReadonlySet<string> | readonly string[]): Store.StoreDelta | null {
    return this.#remove(ids);
  }
  #remove(
    ids: ReadonlySet<string> | readonly string[],
    beforeNotify?: (delta: Store.StoreDelta) => void,
  ): Store.StoreDelta | null {
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
    return this.#publish(result.delta, undefined, beforeNotify);
  }

  public removeWithHistory(
    ids: ReadonlySet<string> | readonly string[],
  ): Store.AppliedRemovalResult | null {
    return this.#preparedElementMutations.removeWithHistory((beforeNotify) =>
      this.#remove(ids, beforeNotify),
    );
  }

  public arrange(selectedIds: ReadonlySet<string>, action: ArrangeAction): Store.StoreDelta | null {
    const delta = new DeltaBuilder();
    for (const band of ["highlight", "content"] as const) {
      if (!this.#ordering.arrange(band, selectedIds, action, delta)) continue;
      this.#instrumentation.bandScans += 1;
    }
    return this.#publish(delta.build(this.#geometryVersion, this.#paintVersion));
  }

  public reorderBands(
    orderedIds: Readonly<Record<RenderBand, readonly string[]>>,
  ): Store.StoreDelta | null {
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
      const ids = mutableBand(this.#bands, band);
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
  public visitDependents(
    targetId: string,
    visitor: (reference: Store.EndpointReference) => void,
  ): void {
    const references = this.#reverseConnections.get(targetId);
    if (references === undefined) return;
    for (const reference of references) {
      this.#instrumentation.reverseDependencyVisits += 1;
      visitor(reference);
    }
  }
  public *beginDependents(targetId: string): IterableIterator<Store.EndpointReference> {
    const references = this.#reverseConnections.get(targetId);
    if (references === undefined) return;
    for (const reference of references) {
      this.#instrumentation.reverseDependencyVisits += 1;
      yield reference;
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
  public materializeSnapshot(input: Store.SnapshotMaterialization): Store.MaterializedSnapshot {
    this.#instrumentation.snapshotMaterializations += 1;
    this.#instrumentation.fullStoreScans += 1;
    return materializeStoreSnapshot(this.#bands, this.#records, input);
  }
  public resetInstrumentation(): void {
    this.#instrumentation = { ...EMPTY_STORE_INSTRUMENTATION };
    this.#runtime.resetStatistics();
  }
  #commitReplacements(
    candidates: readonly ReplacementCandidate[],
    capture?: (history: Store.ElementReplacementHistoryData) => void,
  ): Store.StoreDelta {
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
      this.#replacementHistory,
    );
    this.#overflowCount = result.overflowCount;
    this.#geometryVersion = result.geometryVersion;
    this.#paintVersion = result.paintVersion;
    this.#instrumentation.recordReplacements += result.replacementCount;
    const delta = this.#publish(result.delta)!;
    capture?.(result.history);
    return delta;
  }
  #replacementPorts(): ReplacementPlannerPorts {
    return {
      getRecord: (id) => this.#requireRecord(id),
      getRetainedRecord: (element) => this.#replacementHistory.retainedRecord(element),
      getReferences: (targetId) => this.#reverseConnections.get(targetId),
      onReverseVisit: () => {
        this.#instrumentation.reverseDependencyVisits += 1;
      },
    };
  }
  #requireRecord(id: string): Store.ElementRecord {
    const record = this.#records.get(id);
    if (record === undefined) throw new RangeError(`Unknown element ID: ${id}`);
    return record;
  }
  #publish(
    delta: Store.StoreDelta | null,
    plan?: ElementMutationPlan,
    beforeNotify?: (delta: Store.StoreDelta) => void,
  ): Store.StoreDelta | null {
    if (delta === null) return null;
    this.#preparedElementMutations.publish(delta, plan);
    this.#mutationVersion += 1;
    beforeNotify?.(delta);
    return this.#runtime.publish(delta, this.#instrumentation);
  }
}
