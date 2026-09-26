import type { SpatialBounds } from "./bounds";
import { assertSpatialAggregateCapacity } from "./capacity";
import { cellMembershipCount } from "./cell-membership";
import type { CellRange, IndexedEntry, SpatialReplacement } from "./index-state";

export interface PreparedSpatialMutation {
  readonly commit: () => void;
}

interface StagedInsertion<Id> extends SpatialReplacement<Id> {
  readonly range: CellRange;
}

interface MutationPorts<Id> {
  readonly get: (id: Id) => IndexedEntry<Id> | undefined;
  readonly generation: () => number;
  readonly memberships: number;
  readonly overflow: number;
  readonly recordVersion: number;
  readonly range: (bounds: SpatialBounds) => CellRange;
  readonly commit: (
    removed: readonly IndexedEntry<Id>[],
    inserted: readonly StagedInsertion<Id>[],
  ) => void;
}

/** Validate the final aggregate before changing any live cells, including remove-and-insert swaps. */
export function prepareSpatialMutation<Id>(
  removals: readonly Id[],
  insertions: readonly SpatialReplacement<Id>[],
  ports: MutationPorts<Id>,
): PreparedSpatialMutation {
  const removedIds = new Set(removals);
  if (removedIds.size !== removals.length) throw new RangeError("Duplicate spatial removal ID.");
  const removed: IndexedEntry<Id>[] = [];
  let memberships = ports.memberships;
  let overflow = ports.overflow;
  for (const id of removals) {
    const entry = ports.get(id);
    if (entry === undefined) throw new Error("Spatial index does not contain the ID.");
    removed.push(entry);
    memberships -= entry.cellKeys.length / 2;
    overflow -= Number(entry.overflow);
  }
  const insertedIds = new Set<Id>();
  const inserted: StagedInsertion<Id>[] = [];
  for (const { id, bounds } of insertions) {
    if (insertedIds.has(id) || (!removedIds.has(id) && ports.get(id) !== undefined)) {
      throw new Error("Spatial index already contains the ID.");
    }
    insertedIds.add(id);
    const ownedBounds = { ...bounds };
    const range = ports.range(ownedBounds);
    inserted.push({ id, bounds: ownedBounds, range });
    memberships += cellMembershipCount(range);
    overflow += Number(range.overflow);
  }
  assertSpatialAggregateCapacity(memberships, overflow, ports.recordVersion, insertions.length);
  const generation = ports.generation();
  let consumed = false;
  return {
    commit: () => {
      if (consumed || generation !== ports.generation())
        throw new Error("Prepared spatial mutation is stale.");
      consumed = true;
      if (removed.length !== 0 || inserted.length !== 0) ports.commit(removed, inserted);
    },
  };
}
