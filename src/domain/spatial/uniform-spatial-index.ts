import { prepareSpatialMutation, type PreparedSpatialMutation } from "./mutation-preparation";
import { boundsIntersect, type SpatialBounds } from "./bounds";
import { createCellRange, createSpatialCellKeys } from "./cell-membership";
import { visitSpatialCells } from "./cell-query";
import { popMaximumBottom, pushBottom, type BottomHeapEntry } from "./max-bottom-heap";
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
const EXTENT_REBUILD_OPERATION_SLICE = MAX_EXTENT_REBUILD_SLICE;
const EXTENT_BATCH_HEAP_THRESHOLD = 64;

export class UniformSpatialIndex<Id> {
  private readonly cells: CellColumns = new Map();
  private readonly entries = new Map<Id, IndexedEntry<Id>>();
  private readonly freeSlots: number[] = [];
  private readonly overflowSlots = new Set<number>();
  private readonly rangeScratch: CellRange = {
    maxCellX: 0,
    maxCellY: 0,
    minCellX: 0,
    minCellY: 0,
    overflow: false,
  };
  private readonly slots: (IndexedEntry<Id> | undefined)[] = [];
  private extentHeap: BottomHeapEntry<Id>[] = [];
  private readonly extentBatchHeaps: BottomHeapEntry<Id>[][] = [];
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
    let count = this.extentHeap.length;
    for (const heap of this.extentBatchHeaps) count += heap.length;
    return count;
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
    return prepareSpatialMutation(removals, insertions, {
      get: (id) => this.entries.get(id),
      generation: () => this.mutationGeneration,
      memberships: this.gridMembershipCount,
      overflow: this.overflowSlots.size,
      recordVersion: this.recordVersion,
      range: (bounds) => ({ ...this.prepareRange(bounds) }),
      commit: (removed, inserted) => {
        for (const entry of removed) this.detachEntry(entry, true);
        for (const { id, bounds, range } of inserted) {
          this.attachEntry(this.createEntry(id, bounds, range, this.takeSlot()), range, true);
        }
        this.finishMutation();
      },
    });
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
        this.slots[replacement.replacement.slot] = replacement.replacement;
        if (replacement.replacement.overflow) overflowMaximumChanged = true;
      }
    }
    this.adoptPreparedExtentHeap(state.extentHeap);
    if (overflowMaximumChanged) this.recomputeOverflowMaximum();
    this.recordVersion = state.recordVersion;
    this.finishMutation();
  }

  public beginQuery(bounds: SpatialBounds): SpatialQueryCursor<Id> {
    return new SpatialQueryCursor(
      {
        cells: this.cells,
        generation: () => this.mutationGeneration,
        occupiedCellCount: this.occupiedCellCount,
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
      visitSpatialCells(this.cells, this.slots, this.occupiedCellCount, range, bounds, scratch);
    this.visitOverflow(bounds, scratch);
    return scratch.count;
  }

  public getMaximumBottom(): number | undefined {
    this.rebuildExtentStep(EXTENT_REBUILD_OPERATION_SLICE);
    let stalePops = 0;
    let maximum: number | undefined;
    let cleanupPending = false;
    for (let heapIndex = 0; heapIndex <= this.extentBatchHeaps.length; heapIndex += 1) {
      const heap = heapIndex === 0 ? this.extentHeap : this.extentBatchHeaps[heapIndex - 1]!;
      while (stalePops < MAX_STALE_EXTENT_POPS && this.isHeapHeadStale(heap)) {
        popMaximumBottom(heap);
        stalePops += 1;
      }
      const head = heap[0];
      cleanupPending ||= head !== undefined && this.isHeapEntryStale(head);
      if (head !== undefined) maximum = Math.max(maximum ?? -Infinity, head.bottom);
    }
    this.lastExtentStalePops = stalePops;
    this.extentCleanupPending = cleanupPending;
    this.updateExtentRebuildRecommendation();
    this.beginExtentRebuild();
    if (maximum === undefined) return this.overflowMaximum;
    if (this.overflowMaximum === undefined) return maximum;
    return Math.max(maximum, this.overflowMaximum);
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
        this.extentBatchHeaps.splice(0, rebuild.batchHeapCount);
        this.extentRebuild = undefined;
        this.updateExtentRebuildRecommendation();
        return true;
      }
      const entry = this.slots[rebuild.nextSlot++];
      if (entry !== undefined && !entry.overflow) this.pushRebuildEntry(entry);
    }

    return false;
  }

  private attachEntry(entry: IndexedEntry<Id>, range: CellRange, updateExtent = true): void {
    this.entries.set(entry.id, entry);
    this.slots[entry.slot] = entry;

    if (entry.overflow) {
      this.overflowSlots.add(entry.slot);
      this.overflowMaximum = Math.max(this.overflowMaximum ?? -Infinity, entry.maxY);
      return;
    }

    this.gridEntryCount += 1;
    this.gridMembershipCount += entry.cellKeys.length / 2;
    this.addToCells(entry, range);
    if (updateExtent) this.pushExtentEntry(entry);
  }

  private detachEntry(entry: IndexedEntry<Id>, releaseSlot: boolean): void {
    this.entries.delete(entry.id);
    this.slots[entry.slot] = undefined;

    if (entry.overflow) {
      this.overflowSlots.delete(entry.slot);
      if (entry.maxY === this.overflowMaximum) this.recomputeOverflowMaximum();
    } else {
      this.gridEntryCount -= 1;
      this.gridMembershipCount -= entry.cellKeys.length / 2;
      this.removeFromCells(entry);
    }

    if (releaseSlot) this.freeSlots.push(entry.slot);
  }

  private addToCells(entry: IndexedEntry<Id>, range: CellRange): void {
    let keyIndex = 0;
    for (let cellX = range.minCellX; cellX <= range.maxCellX; cellX += 1) {
      let column = this.cells.get(cellX);
      if (column === undefined) {
        column = new Map();
        this.cells.set(cellX, column);
      }
      for (let cellY = range.minCellY; cellY <= range.maxCellY; cellY += 1) {
        let bucket = column.get(cellY);
        if (bucket === undefined) {
          bucket = new Set();
          column.set(cellY, bucket);
          this.occupiedCellCount += 1;
        }
        bucket.add(entry.slot);
        keyIndex += 2;
      }
    }

    if (keyIndex !== entry.cellKeys.length)
      throw new Error("Spatial cell membership is inconsistent.");
  }

  private removeFromCells(entry: IndexedEntry<Id>): void {
    for (let index = 0; index < entry.cellKeys.length; index += 2) {
      const cellX = entry.cellKeys[index];
      const cellY = entry.cellKeys[index + 1];
      if (cellX === undefined || cellY === undefined) continue;
      const column = this.cells.get(cellX);
      const bucket = column?.get(cellY);
      bucket?.delete(entry.slot);
      if (bucket?.size === 0) {
        column?.delete(cellY);
        this.occupiedCellCount -= 1;
      }
      if (column?.size === 0) this.cells.delete(cellX);
    }
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
    this.attachEntry(replacement.replacement, replacement.range, false);
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
      extentEntry: (entry) => this.extentEntry(entry),
      generation: this.mutationGeneration,
      getCurrent: (id) => this.entries.get(id),
      owner: this,
      prepareRange: (bounds) => ({ ...this.prepareRange(bounds) }),
      recordVersion: this.recordVersion,
    };
  }

  private visitOverflow(bounds: SpatialBounds, scratch: SpatialQueryScratch<Id>): void {
    for (const slot of this.overflowSlots) {
      const entry = this.slots[slot];
      if (entry !== undefined) scratch.visit(slot, entry.id, boundsIntersect(entry, bounds));
    }
  }

  private pushExtentEntry(entry: IndexedEntry<Id>): void {
    pushBottom(this.extentHeap, this.extentEntry(entry));
    this.pushRebuildEntry(entry);
  }

  private extentEntry(entry: IndexedEntry<Id>): BottomHeapEntry<Id> {
    return { bottom: entry.maxY, id: entry.id, recordVersion: entry.recordVersion };
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

  private isHeapHeadStale(heap: readonly BottomHeapEntry<Id>[]): boolean {
    const head = heap[0];
    return head !== undefined && this.isHeapEntryStale(head);
  }

  private isHeapEntryStale(heapEntry: BottomHeapEntry<Id>): boolean {
    const current = this.entries.get(heapEntry.id);
    return (
      current === undefined ||
      current.overflow ||
      current.recordVersion !== heapEntry.recordVersion ||
      current.maxY !== heapEntry.bottom
    );
  }

  private recomputeOverflowMaximum(): void {
    let maximum: number | undefined;
    for (const slot of this.overflowSlots) {
      const entry = this.slots[slot];
      if (entry !== undefined) maximum = Math.max(maximum ?? -Infinity, entry.maxY);
    }
    this.overflowMaximum = maximum;
  }

  private takeSlot(): number {
    return this.freeSlots.pop() ?? this.slots.length;
  }

  private finishMutation(): void {
    this.mutationGeneration += 1;
    this.updateExtentRebuildRecommendation();
    this.beginExtentRebuild();
    this.rebuildExtentStep(EXTENT_REBUILD_OPERATION_SLICE);
  }

  private updateExtentRebuildRecommendation(): void {
    this.extentRebuildRecommended =
      this.extentHeapEntryCount - this.gridEntryCount > this.entries.size;
  }

  private adoptPreparedExtentHeap(heap: BottomHeapEntry<Id>[]): void {
    const rebuild = this.extentRebuild;
    if (rebuild !== undefined && heap.length <= EXTENT_BATCH_HEAP_THRESHOLD) {
      if (rebuild.deltaHeap === undefined) {
        rebuild.deltaHeap = [];
        this.extentBatchHeaps.push(rebuild.deltaHeap);
      }
      for (const entry of heap) pushBottom(rebuild.deltaHeap, entry);
    } else if (rebuild !== undefined || heap.length > EXTENT_BATCH_HEAP_THRESHOLD) {
      this.extentBatchHeaps.push(heap);
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
