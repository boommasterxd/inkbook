import {
  prepareSpatialMutation,
  type MutationPorts,
  type PreparedSpatialMutation,
} from "./mutation-preparation";
import { prepareSpatialMutationTimeSliced } from "./mutation-shadow";
import type { SpatialBounds } from "./bounds";
import { createCellRange, createSpatialCellKeys, updateSpatialCells } from "./cell-membership";
import { prepareSpatialRemoval } from "./removal-preparation";
import { SpatialMap } from "./spatial-map";
import { SpatialSet } from "./spatial-set";
import { SpatialFreeSlots, SpatialSlots } from "./slot-storage";
import { maximumOverflowBottom, visitOverflowEntries, visitSpatialCells } from "./cell-query";
import {
  bottomHeapEntry,
  pushBottom,
  scanMaximumBottom,
  shouldRebuildExtent,
  type BottomHeapEntry,
} from "./max-bottom-heap";
import { SpatialQueryCursor } from "./query-cursor";
import { SpatialQueryScratch } from "./query-scratch";
import {
  PREPARED_REPLACEMENTS,
  type CellColumns,
  type CellRange,
  type ExtentRebuild,
  type IndexedEntry,
  type PreparedReplacement,
  type PreparedSpatialReplacements,
  type PreparedSpatialState,
  type SpatialReplacement,
} from "./index-state";
import {
  prepareSpatialReplacements,
  prepareSpatialReplacementsTimeSliced,
  type SpatialReplacementPreparationPorts,
  type SpatialReplacementPreparationScheduler,
} from "./replacement-preparation";

export type { PreparedSpatialReplacements, SpatialReplacement } from "./index-state";

export const SPATIAL_CELL_SIZE = 256;
export const MAX_ELEMENT_CELLS = 256;
export { MAX_OVERFLOW_ELEMENTS, MAX_SPATIAL_MEMBERSHIPS } from "./capacity";
export const MAX_STALE_EXTENT_POPS = 256;
export const MAX_EXTENT_REBUILD_SLICE = 256;
const EXTENT_BATCH_HEAP_THRESHOLD = 64;

export class UniformSpatialIndex<Id> {
  private cells: CellColumns = new SpatialMap();
  private entries = new SpatialMap<Id, IndexedEntry<Id>>();
  private freeSlots = new SpatialFreeSlots();
  private overflowSlots = new SpatialSet<number>();
  private readonly rangeScratch: CellRange = {
    maxCellX: 0,
    maxCellY: 0,
    minCellX: 0,
    minCellY: 0,
    overflow: false,
  };
  private slots = new SpatialSlots<IndexedEntry<Id>>();
  private extentHeap: BottomHeapEntry<Id>[] = [];
  private readonly extentBatchHeaps: BottomHeapEntry<Id>[][] = [];
  private extentBatchEntryCount = 0;
  private extentRebuild: ExtentRebuild<Id> | undefined;
  private gridEntryCount = 0;
  private gridMembershipCount = 0;
  private mutationGeneration = 0;
  private occupiedCellCount = 0;
  private overflowMaximum: number | undefined;
  private recordVersion = 0;

  public extentCleanupPending = false;
  public extentRebuildRecommended = false;
  public lastExtentStalePops = 0;

  public get cellCount(): number {
    return this.occupiedCellCount;
  }

  public get overflowCount(): number {
    return this.overflowSlots.size;
  }

  public get membershipCount(): number {
    return this.gridMembershipCount;
  }

  public get extentHeapEntryCount(): number {
    return this.extentHeap.length + this.extentBatchEntryCount;
  }

  public get size(): number {
    return this.entries.size;
  }

  public insert(id: Id, bounds: SpatialBounds): void {
    this.insertMany([{ bounds, id }]);
  }

  public insertMany(insertions: readonly SpatialReplacement<Id>[]): void {
    if (insertions.length !== 0) this.prepareMutation([], insertions).commit();
  }

  public prepareMutation(
    removals: readonly Id[],
    insertions: readonly SpatialReplacement<Id>[],
  ): PreparedSpatialMutation {
    return prepareSpatialMutation(removals, insertions, this.mutationPorts());
  }

  public prepareMutationTimeSliced(
    removals: readonly Id[],
    insertions: readonly SpatialReplacement<Id>[],
    scheduler: SpatialReplacementPreparationScheduler,
  ): Promise<PreparedSpatialMutation | "cancelled"> {
    return prepareSpatialMutationTimeSliced(
      removals,
      insertions,
      {
        mutation: this.mutationPorts(),
        entries: this.entries,
        prepareRemoval: (stage, scheduler, generation) =>
          prepareSpatialRemoval(
            stage,
            {
              generation: () => this.mutationGeneration,
              fork: () => this.forkRemovalState(),
              remove: (shadow, entry) => shadow.detachEntry(entry, true, false),
              overflowMaximum: this.overflowMaximum,
              overflowSlots: (shadow) => shadow.overflowSlots,
              overflowBottom: (shadow, slot) => shadow.slots.get(slot)?.maxY,
              setOverflowMaximum: (shadow, maximum) => {
                shadow.overflowMaximum = maximum;
              },
              adopt: (shadow) => {
                this.cells = shadow.cells;
                this.entries = shadow.entries;
                this.freeSlots = shadow.freeSlots;
                this.overflowSlots = shadow.overflowSlots;
                this.slots = shadow.slots;
                this.gridEntryCount = shadow.gridEntryCount;
                this.gridMembershipCount = shadow.gridMembershipCount;
                this.occupiedCellCount = shadow.occupiedCellCount;
                this.overflowMaximum = shadow.overflowMaximum;
                this.mutationGeneration += 1;
                this.updateExtentRebuildRecommendation();
                this.beginExtentRebuild();
              },
            },
            scheduler,
            generation,
          ),
        createShadow: () => {
          const shadow = new UniformSpatialIndex<Id>();
          shadow.recordVersion = this.recordVersion;
          return shadow;
        },
        appendRetained: (shadow, entry) => {
          const retained = { ...entry, slot: shadow.slots.length };
          shadow.attachEntry(retained, false);
          return retained;
        },
        appendInserted: (shadow, { id, bounds, range }) => {
          const entry = shadow.createEntry(id, bounds, range, shadow.slots.length);
          shadow.attachEntry(entry, false);
          return entry;
        },
        adoptShadow: (shadow, generation, extentHeap) => {
          shadow.extentHeap = extentHeap;
          Object.assign(this, shadow);
          this.mutationGeneration = generation + 1;
        },
      },
      scheduler,
    );
  }

  private forkRemovalState(): UniformSpatialIndex<Id> {
    const shadow = Object.assign(new UniformSpatialIndex<Id>(), this);
    shadow.cells = this.cells.fork();
    shadow.entries = this.entries.fork();
    shadow.freeSlots = this.freeSlots.fork();
    shadow.overflowSlots = this.overflowSlots.fork();
    shadow.slots = this.slots.fork();
    return shadow;
  }

  private mutationPorts(): MutationPorts<Id> {
    return {
      get: (id) => this.entries.get(id),
      generation: () => this.mutationGeneration,
      heapEntries: this.extentHeapEntryCount,
      memberships: this.gridMembershipCount,
      overflow: this.overflowSlots.size,
      recordVersion: this.recordVersion,
      range: (bounds) => ({ ...this.prepareRange(bounds) }),
      commit: (removed, inserted) => {
        for (const entry of removed) this.detachEntry(entry, true);
        for (const { id, bounds, range } of inserted) {
          this.attachEntry(this.createEntry(id, bounds, range, this.takeSlot()));
        }
        this.finishMutation();
      },
    };
  }

  public replace(id: Id, bounds: SpatialBounds): void {
    this.commitPreparedReplacements(this.prepareReplacements([{ bounds, id }]));
  }

  public remove(id: Id): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined) return false;

    this.detachEntry(entry, true);
    this.finishMutation();
    return true;
  }

  public prepareReplacements(
    replacements: readonly SpatialReplacement<Id>[],
  ): PreparedSpatialReplacements<Id> {
    this.rebuildExtentStep(MAX_EXTENT_REBUILD_SLICE);
    return prepareSpatialReplacements(replacements, this.replacementPreparationPorts());
  }

  public async prepareReplacementsTimeSliced(
    replacements: readonly SpatialReplacement<Id>[],
    scheduler: SpatialReplacementPreparationScheduler,
  ): Promise<PreparedSpatialReplacements<Id> | "cancelled"> {
    this.rebuildExtentStep(MAX_EXTENT_REBUILD_SLICE);
    return prepareSpatialReplacementsTimeSliced(
      replacements,
      this.replacementPreparationPorts(),
      scheduler,
    );
  }

  public commitPreparedReplacements(plan: PreparedSpatialReplacements<Id>): void {
    const state = plan[PREPARED_REPLACEMENTS] as PreparedSpatialState<Id, UniformSpatialIndex<Id>>;
    if (state.owner !== this || state.consumed || state.generation !== this.mutationGeneration) {
      throw new Error("Prepared spatial replacements are stale or belong to another index.");
    }
    state.consumed = true;
    if (state.replacements.length === 0) return;
    let overflowMaximumChanged = false;
    for (const replacement of state.replacements) {
      if (replacement.membershipChanged) this.commitChangedMembership(replacement);
      else {
        this.entries.set(replacement.replacement.id, replacement.replacement);
        this.slots.set(replacement.replacement.slot, replacement.replacement);
        if (replacement.replacement.overflow) overflowMaximumChanged = true;
      }
    }
    this.adoptPreparedExtentHeap(state.extentHeap);
    if (overflowMaximumChanged)
      this.overflowMaximum = maximumOverflowBottom(this.overflowSlots, this.slots);
    this.recordVersion = state.recordVersion;
    this.finishMutation();
  }

  public beginQuery(bounds: SpatialBounds): SpatialQueryCursor<Id> {
    return new SpatialQueryCursor(
      {
        cells: this.cells,
        generation: () => this.mutationGeneration,
        overflowSlots: this.overflowSlots,
        slots: this.slots,
      },
      { ...this.prepareRange(bounds) },
      bounds,
    );
  }

  public query(bounds: SpatialBounds, scratch: SpatialQueryScratch<Id>): number {
    const range = this.prepareRange(bounds);
    scratch.begin(this.slots.length);

    if (this.occupiedCellCount > 0)
      visitSpatialCells(this.cells, this.slots, range, bounds, scratch);
    visitOverflowEntries(this.overflowSlots, this.slots, bounds, scratch);
    return scratch.count;
  }

  public getMaximumBottom(): number | undefined {
    this.rebuildExtentStep(MAX_EXTENT_REBUILD_SLICE);
    const { stalePops, batchStalePops, cleanupPending, maximum } = scanMaximumBottom(
      this.extentHeap,
      this.extentBatchHeaps,
      this.entries,
      MAX_STALE_EXTENT_POPS,
      this.overflowMaximum,
    );
    this.extentBatchEntryCount -= batchStalePops;
    this.lastExtentStalePops = stalePops;
    this.extentCleanupPending = cleanupPending;
    this.updateExtentRebuildRecommendation();
    this.beginExtentRebuild();
    return maximum;
  }

  public beginExtentRebuild(): boolean {
    if (this.extentRebuild !== undefined || !this.extentRebuildRecommended) return false;

    this.extentRebuild = {
      batchHeapCount: this.extentBatchHeaps.length,
      deltaHeap: undefined,
      heap: [],
      nextSlot: 0,
      slotLimit: this.slots.length,
      versions: new Map(),
    };
    return true;
  }

  public rebuildExtentStep(maxEntries = MAX_EXTENT_REBUILD_SLICE): boolean {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_EXTENT_REBUILD_SLICE) {
      throw new RangeError(
        `Extent rebuild slices must contain 1-${MAX_EXTENT_REBUILD_SLICE} entries.`,
      );
    }

    const rebuild = this.extentRebuild;
    if (rebuild === undefined) return false;

    for (let processed = 0; processed < maxEntries; processed += 1) {
      if (rebuild.nextSlot >= rebuild.slotLimit) {
        this.extentHeap = rebuild.heap;
        for (const heap of this.extentBatchHeaps.splice(0, rebuild.batchHeapCount))
          this.extentBatchEntryCount -= heap.length;
        this.extentRebuild = undefined;
        this.updateExtentRebuildRecommendation();
        return true;
      }
      const entry = this.slots.get(rebuild.nextSlot++);
      if (entry !== undefined && !entry.overflow) this.pushRebuildEntry(entry);
    }

    return false;
  }

  private attachEntry(entry: IndexedEntry<Id>, updateExtent = true): void {
    this.entries.set(entry.id, entry);
    this.slots.set(entry.slot, entry);

    if (entry.overflow) {
      this.overflowSlots.add(entry.slot);
      this.overflowMaximum = Math.max(this.overflowMaximum ?? -Infinity, entry.maxY);
      return;
    }

    this.gridEntryCount += 1;
    this.gridMembershipCount += entry.cellKeys.length / 2;
    this.occupiedCellCount += updateSpatialCells(this.cells, entry, true);
    if (updateExtent) this.pushExtentEntry(entry);
  }

  private detachEntry(entry: IndexedEntry<Id>, releaseSlot: boolean, refreshOverflow = true): void {
    this.entries.delete(entry.id);
    this.slots.set(entry.slot, undefined);

    if (entry.overflow) {
      this.overflowSlots.delete(entry.slot);
      if (refreshOverflow && entry.maxY === this.overflowMaximum)
        this.overflowMaximum = maximumOverflowBottom(this.overflowSlots, this.slots);
    } else {
      this.gridEntryCount -= 1;
      this.gridMembershipCount -= entry.cellKeys.length / 2;
      this.occupiedCellCount += updateSpatialCells(this.cells, entry, false);
    }

    if (releaseSlot) this.freeSlots.push(entry.slot);
  }

  private createEntry(
    id: Id,
    bounds: SpatialBounds,
    range: CellRange,
    slot: number,
  ): IndexedEntry<Id> {
    return this.createEntryAtVersion(id, bounds, range, slot, this.nextRecordVersion());
  }

  private createEntryAtVersion(
    id: Id,
    bounds: SpatialBounds,
    range: CellRange,
    slot: number,
    recordVersion: number,
    cellKeys?: readonly number[],
  ): IndexedEntry<Id> {
    return {
      cellKeys: cellKeys ?? (range.overflow ? [] : createSpatialCellKeys(range)),
      id,
      maxX: bounds.maxX,
      maxY: bounds.maxY,
      minX: bounds.minX,
      minY: bounds.minY,
      overflow: range.overflow,
      recordVersion,
      slot,
    };
  }

  private commitChangedMembership(replacement: PreparedReplacement<Id>): void {
    this.detachEntry(replacement.current, false);
    this.attachEntry(replacement.replacement, false);
  }

  private prepareRange(bounds: SpatialBounds): CellRange {
    return createCellRange(bounds, SPATIAL_CELL_SIZE, MAX_ELEMENT_CELLS, this.rangeScratch);
  }

  private replacementPreparationPorts(): SpatialReplacementPreparationPorts<
    Id,
    UniformSpatialIndex<Id>
  > {
    return {
      createReplacement: (current, bounds, range, version, retainCellKeys) =>
        this.createEntryAtVersion(
          current.id,
          bounds,
          range,
          current.slot,
          version,
          retainCellKeys ? current.cellKeys : undefined,
        ),
      currentMemberships: this.gridMembershipCount,
      currentOverflow: this.overflowSlots.size,
      extentEntry: bottomHeapEntry,
      generation: this.mutationGeneration,
      getCurrent: (id) => this.entries.get(id),
      owner: this,
      prepareRange: (bounds) => ({ ...this.prepareRange(bounds) }),
      recordVersion: this.recordVersion,
    };
  }

  private pushExtentEntry(entry: IndexedEntry<Id>): void {
    pushBottom(this.extentHeap, bottomHeapEntry(entry));
    this.pushRebuildEntry(entry);
  }

  private pushRebuildEntry(entry: IndexedEntry<Id>): void {
    const rebuild = this.extentRebuild;
    if (rebuild === undefined || entry.overflow) return;
    if (rebuild.versions.get(entry.id) === entry.recordVersion) return;

    rebuild.versions.set(entry.id, entry.recordVersion);
    pushBottom(rebuild.heap, {
      bottom: entry.maxY,
      id: entry.id,
      recordVersion: entry.recordVersion,
    });
  }

  private takeSlot(): number {
    return this.freeSlots.pop() ?? this.slots.length;
  }

  private finishMutation(): void {
    this.mutationGeneration += 1;
    this.updateExtentRebuildRecommendation();
    this.beginExtentRebuild();
    this.rebuildExtentStep(MAX_EXTENT_REBUILD_SLICE);
  }

  private updateExtentRebuildRecommendation(): void {
    this.extentRebuildRecommended = shouldRebuildExtent(
      this.extentHeapEntryCount,
      this.gridEntryCount,
      this.entries.size,
    );
  }

  private adoptPreparedExtentHeap(heap: BottomHeapEntry<Id>[]): void {
    const rebuild = this.extentRebuild;
    if (rebuild !== undefined && heap.length <= EXTENT_BATCH_HEAP_THRESHOLD) {
      if (rebuild.deltaHeap === undefined) {
        rebuild.deltaHeap = [];
        this.extentBatchHeaps.push(rebuild.deltaHeap);
      }
      for (const entry of heap) pushBottom(rebuild.deltaHeap, entry);
      this.extentBatchEntryCount += heap.length;
    } else if (rebuild !== undefined || heap.length > EXTENT_BATCH_HEAP_THRESHOLD) {
      this.extentBatchHeaps.push(heap);
      this.extentBatchEntryCount += heap.length;
    } else for (const entry of heap) pushBottom(this.extentHeap, entry);
  }

  private nextRecordVersion(): number {
    if (this.recordVersion >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Spatial record version capacity is exhausted.");
    }
    this.recordVersion += 1;
    return this.recordVersion;
  }
}
