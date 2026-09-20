import type { SpatialBounds } from "./bounds";
import { assertSpatialAggregateCapacity } from "./capacity";
import { cellMembershipCount } from "./cell-membership";
import type { CellRange, SpatialReplacement } from "./index-state";

declare const PREPARED_INSERTION_ID: unique symbol;

export interface PreparedSpatialInsertions<Id> {
  readonly insertionCount: number;
  readonly [PREPARED_INSERTION_ID]?: Id;
}

interface StagedInsertion<Id> extends SpatialReplacement<Id> {
  readonly range: CellRange;
}

interface PreparedInsertionState<Id> {
  readonly generation: number;
  readonly insertions: readonly StagedInsertion<Id>[];
}

export interface SpatialInsertionPreparationPorts<Id> {
  readonly currentMemberships: number;
  readonly currentOverflow: number;
  readonly generation: number;
  readonly has: (id: Id) => boolean;
  readonly prepareRange: (bounds: SpatialBounds) => CellRange;
  readonly recordVersion: number;
}

/** Each index owns its tokens; retained plans do not retain the owning index. */
export class SpatialInsertionPreparation<Id> {
  private readonly plans = new WeakMap<PreparedSpatialInsertions<Id>, PreparedInsertionState<Id>>();

  public prepare(
    insertions: readonly SpatialReplacement<Id>[],
    ports: SpatialInsertionPreparationPorts<Id>,
  ): PreparedSpatialInsertions<Id> {
    const ids = new Set<Id>();
    const staged: StagedInsertion<Id>[] = [];
    let memberships = ports.currentMemberships;
    let overflow = ports.currentOverflow;
    for (const { bounds, id } of insertions) {
      if (ids.has(id) || ports.has(id)) {
        throw new Error("Spatial index already contains the ID.");
      }
      ids.add(id);
      const snapshot = Object.freeze({ ...bounds });
      const range = Object.freeze({ ...ports.prepareRange(snapshot) });
      memberships += cellMembershipCount(range);
      overflow += Number(range.overflow);
      staged.push(Object.freeze({ bounds: snapshot, id, range }));
    }
    assertSpatialAggregateCapacity(memberships, overflow, ports.recordVersion, staged.length);
    const token = Object.freeze({ insertionCount: staged.length });
    this.plans.set(token, { generation: ports.generation, insertions: Object.freeze(staged) });
    return token;
  }

  public consume(
    plan: PreparedSpatialInsertions<Id>,
    generation: number,
  ): readonly StagedInsertion<Id>[] {
    const state = this.plans.get(plan);
    if (state === undefined || state.generation !== generation) {
      throw new Error("Prepared spatial insertions are stale or belong to another index.");
    }
    this.plans.delete(plan);
    return state.insertions;
  }
}
