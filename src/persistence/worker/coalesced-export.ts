import { assertSafeCounter } from "./identity";
import type { DocumentRevision, ElementId, RenderBand } from "./protocol";

export interface ExportDelta<TElement, TPage> {
  readonly changedElements?: readonly TElement[];
  readonly dirtyBands?: readonly RenderBand[];
  readonly modelRevision: DocumentRevision;
  readonly page?: TPage;
  readonly removedIds?: readonly ElementId[];
}

interface IncrementalExportPlan<TElement, TPage> {
  readonly baseModelRevision: DocumentRevision;
  readonly changedElements: readonly TElement[];
  readonly modelRevision: DocumentRevision;
  readonly orderChanges: Readonly<Partial<Record<RenderBand, readonly ElementId[]>>>;
  readonly page?: TPage;
  readonly removedIds: readonly ElementId[];
  readonly type: "incremental";
}

interface FullExportPlan<TSnapshot> {
  readonly baseModelRevision: null;
  readonly modelRevision: DocumentRevision;
  readonly snapshot: TSnapshot;
  readonly type: "full";
}

export type CoalescedExportPlan<TElement, TPage, TSnapshot> =
  FullExportPlan<TSnapshot> | IncrementalExportPlan<TElement, TPage>;

export interface ExportMaterialization<TSnapshot> {
  readonly orderByBand?: Readonly<Partial<Record<RenderBand, readonly ElementId[]>>>;
  readonly snapshot?: TSnapshot;
}

export class CoalescedExportTarget<TElement, TPage> {
  readonly #baseModelRevision: DocumentRevision;
  readonly #getElementId: (element: TElement) => ElementId;
  readonly #changedElements = new Map<ElementId, TElement>();
  readonly #removedIds = new Set<ElementId>();
  readonly #dirtyBands = new Set<RenderBand>();
  #modelRevision: DocumentRevision;
  #latestPage: TPage | undefined;
  #hasPage = false;
  #requiresFullSnapshot = false;

  public constructor(
    baseModelRevision: DocumentRevision,
    getElementId: (element: TElement) => ElementId,
  ) {
    assertSafeCounter(baseModelRevision, "baseModelRevision");
    this.#baseModelRevision = baseModelRevision;
    this.#modelRevision = baseModelRevision;
    this.#getElementId = getElementId;
  }

  public get modelRevision(): DocumentRevision {
    return this.#modelRevision;
  }

  public get requiresFullSnapshot(): boolean {
    return this.#requiresFullSnapshot;
  }

  public record(delta: ExportDelta<TElement, TPage>): void {
    assertSafeCounter(delta.modelRevision, "modelRevision");
    if (delta.modelRevision < this.#modelRevision) {
      throw new RangeError("A coalesced export target cannot move to an older revision.");
    }
    this.#modelRevision = delta.modelRevision;
    if (this.#requiresFullSnapshot) {
      return;
    }
    this.#recordChanges(delta.changedElements ?? []);
    this.#recordRemovals(delta.removedIds ?? []);
    for (const band of delta.dirtyBands ?? []) {
      this.#dirtyBands.add(band);
    }
    if ("page" in delta) {
      this.#latestPage = delta.page;
      this.#hasPage = true;
    }
  }

  public requireFullSnapshot(modelRevision: DocumentRevision): void {
    assertSafeCounter(modelRevision, "modelRevision");
    if (modelRevision < this.#modelRevision) {
      throw new RangeError("A full export target cannot move to an older revision.");
    }
    this.#modelRevision = modelRevision;
    this.#requiresFullSnapshot = true;
    this.#changedElements.clear();
    this.#removedIds.clear();
    this.#dirtyBands.clear();
    this.#latestPage = undefined;
    this.#hasPage = false;
  }

  public materialize<TSnapshot>(
    values: ExportMaterialization<TSnapshot>,
  ): CoalescedExportPlan<TElement, TPage, TSnapshot> {
    if (this.#requiresFullSnapshot) {
      if (!("snapshot" in values)) {
        throw new Error("A baseline-invalidated export requires a complete snapshot.");
      }
      return {
        baseModelRevision: null,
        modelRevision: this.#modelRevision,
        snapshot: values.snapshot,
        type: "full",
      };
    }

    const orderChanges = this.#materializeOrders(values.orderByBand ?? {});
    const plan: IncrementalExportPlan<TElement, TPage> = {
      baseModelRevision: this.#baseModelRevision,
      changedElements: [...this.#changedElements.values()],
      modelRevision: this.#modelRevision,
      orderChanges,
      removedIds: [...this.#removedIds],
      type: "incremental",
      ...(this.#hasPage ? { page: this.#latestPage as TPage } : {}),
    };
    return plan;
  }

  #materializeOrders(
    orderByBand: Readonly<Partial<Record<RenderBand, readonly ElementId[]>>>,
  ): Readonly<Partial<Record<RenderBand, readonly ElementId[]>>> {
    const result: Partial<Record<RenderBand, readonly ElementId[]>> = {};
    for (const band of this.#dirtyBands) {
      const order = orderByBand[band];
      if (order === undefined) {
        throw new Error(`Dirty render band ${band} requires its complete order.`);
      }
      result[band] = order;
    }
    return result;
  }

  #recordChanges(elements: readonly TElement[]): void {
    for (const element of elements) {
      const id = this.#getElementId(element);
      this.#removedIds.delete(id);
      this.#changedElements.set(id, element);
    }
  }

  #recordRemovals(ids: readonly ElementId[]): void {
    for (const id of ids) {
      this.#changedElements.delete(id);
      this.#removedIds.add(id);
    }
  }
}
