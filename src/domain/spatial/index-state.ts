import type { SpatialBounds } from "./bounds";
import type { BottomHeapEntry } from "./max-bottom-heap";
import type { SpatialMap } from "./spatial-map";
import type { SpatialSet } from "./spatial-set";

export interface IndexedEntry<Id> extends SpatialBounds {
  readonly cellKeys: readonly number[];
  readonly id: Id;
  readonly overflow: boolean;
  readonly recordVersion: number;
  readonly slot: number;
}

export interface CellRange {
  maxCellX: number;
  maxCellY: number;
  minCellX: number;
  minCellY: number;
  overflow: boolean;
}

export interface ExtentRebuild<Id> {
  readonly batchHeapCount: number;
  deltaHeap: BottomHeapEntry<Id>[] | undefined;
  readonly heap: BottomHeapEntry<Id>[];
  nextSlot: number;
  readonly slotLimit: number;
  readonly versions: Map<Id, number>;
}

export interface PreparedReplacement<Id> {
  readonly membershipChanged: boolean;
  readonly current: IndexedEntry<Id>;
  readonly replacement: IndexedEntry<Id>;
  readonly range: CellRange;
}

export interface PreparedSpatialState<Id, Owner> {
  consumed: boolean;
  readonly extentHeap: BottomHeapEntry<Id>[];
  readonly generation: number;
  readonly owner: Owner;
  readonly replacements: readonly PreparedReplacement<Id>[];
  readonly recordVersion: number;
}

export const PREPARED_REPLACEMENTS = Symbol("prepared-spatial-replacements");
declare const PREPARED_REPLACEMENT_ID: unique symbol;

export interface SpatialReplacement<Id> {
  readonly bounds: SpatialBounds;
  readonly id: Id;
}

export type PreparedSpatialReplacements<Id> = Readonly<{
  readonly replacementCount: number;
  readonly [PREPARED_REPLACEMENTS]: unknown;
  readonly [PREPARED_REPLACEMENT_ID]?: Id;
}>;

export type SpatialMapSource<Key, Value> = Pick<
  ReadonlyMap<Key, Value>,
  "get" | "size" | "entries" | typeof Symbol.iterator
>;
export type SpatialBucketSource = Iterable<number> & { readonly size: number };
export type SpatialColumnSource = SpatialMapSource<number, SpatialBucketSource>;
export type CellColumnSource = SpatialMapSource<number, SpatialColumnSource>;
export type CellColumns = SpatialMap<number, SpatialMap<number, SpatialSet<number>>>;
