import type { SpatialBounds } from "./bounds";
import { assertSpatialAggregateCapacity } from "./capacity";
import { cellMembershipCount, hasSameCellMembership } from "./cell-membership";
import {
  PREPARED_REPLACEMENTS,
  type CellRange,
  type IndexedEntry,
  type PreparedReplacement,
  type PreparedSpatialReplacements,
  type PreparedSpatialState,
  type SpatialReplacement,
} from "./index-state";
import { heapifyBottom, type BottomHeapEntry } from "./max-bottom-heap";

const HEAPIFY_ADMISSION_SIZE = 1_000;

export interface SpatialReplacementPreparationPorts<Id, Owner extends object> {
  readonly createReplacement: (
    current: IndexedEntry<Id>,
    bounds: SpatialBounds,
    range: CellRange,
    recordVersion: number,
    retainCellKeys: boolean,
  ) => IndexedEntry<Id>;
  readonly currentMemberships: number;
  readonly currentOverflow: number;
  readonly extentEntry: (entry: IndexedEntry<Id>) => BottomHeapEntry<Id>;
  readonly generation: number;
  readonly getCurrent: (id: Id) => IndexedEntry<Id> | undefined;
  readonly owner: Owner;
  readonly prepareRange: (bounds: SpatialBounds) => CellRange;
  readonly recordVersion: number;
}

export interface SpatialReplacementPreparationScheduler {
  readonly isCancelled?: () => boolean;
  readonly shouldYield: () => boolean;
  readonly yieldControl: () => Promise<void>;
}

interface StagedReplacement<Id> {
  readonly bounds: SpatialBounds;
  readonly current: IndexedEntry<Id>;
  readonly range: CellRange;
}

interface StagedState<Id> {
  readonly entries: StagedReplacement<Id>[];
  readonly ids: Set<Id>;
  memberships: number;
  overflow: number;
}

export function prepareSpatialReplacements<Id, Owner extends object>(
  replacements: readonly SpatialReplacement<Id>[],
  ports: SpatialReplacementPreparationPorts<Id, Owner>,
): PreparedSpatialReplacements<Id> {
  const staged = stageReplacements(replacements, ports);
  return finishPreparation(prepareEntries(staged.entries, ports), ports);
}

export async function prepareSpatialReplacementsTimeSliced<Id, Owner extends object>(
  replacements: readonly SpatialReplacement<Id>[],
  ports: SpatialReplacementPreparationPorts<Id, Owner>,
  scheduler: SpatialReplacementPreparationScheduler,
): Promise<PreparedSpatialReplacements<Id> | "cancelled"> {
  const staged = await stageReplacementsTimeSliced(replacements, ports, scheduler);
  if (staged === "cancelled") return staged;
  const prepared = await prepareEntriesTimeSliced(staged.entries, ports, scheduler);
  if (prepared === "cancelled") return prepared;
  const result = await finishPreparationTimeSliced(prepared, ports, scheduler);
  if (result === "cancelled") return result;
  return (await checkpoint(scheduler)) ? result : "cancelled";
}

function stageReplacements<Id, Owner extends object>(
  replacements: readonly SpatialReplacement<Id>[],
  ports: SpatialReplacementPreparationPorts<Id, Owner>,
): StagedState<Id> {
  const state = createStageState<Id>(ports.currentMemberships, ports.currentOverflow);
  for (const replacement of replacements) stageOne(replacement, state, ports);
  assertStageCapacity(state, ports.recordVersion);
  return state;
}

async function stageReplacementsTimeSliced<Id, Owner extends object>(
  replacements: readonly SpatialReplacement<Id>[],
  ports: SpatialReplacementPreparationPorts<Id, Owner>,
  scheduler: SpatialReplacementPreparationScheduler,
): Promise<StagedState<Id> | "cancelled"> {
  const state = createStageState<Id>(ports.currentMemberships, ports.currentOverflow);
  for (const replacement of replacements) {
    stageOne(replacement, state, ports);
    if (!(await checkpoint(scheduler))) return "cancelled";
  }
  assertStageCapacity(state, ports.recordVersion);
  return state;
}

function createStageState<Id>(memberships: number, overflow: number): StagedState<Id> {
  return { entries: [], ids: new Set(), memberships, overflow };
}

function stageOne<Id, Owner extends object>(
  replacement: SpatialReplacement<Id>,
  state: StagedState<Id>,
  ports: SpatialReplacementPreparationPorts<Id, Owner>,
): void {
  if (state.ids.has(replacement.id))
    throw new RangeError("Spatial replacement IDs must be unique.");
  state.ids.add(replacement.id);
  const current = ports.getCurrent(replacement.id);
  if (current === undefined) throw new Error("Spatial index does not contain the ID.");
  const range = ports.prepareRange(replacement.bounds);
  state.memberships += cellMembershipCount(range) - current.cellKeys.length / 2;
  state.overflow += Number(range.overflow) - Number(current.overflow);
  state.entries.push({ bounds: replacement.bounds, current, range });
}

function assertStageCapacity<Id>(state: StagedState<Id>, recordVersion: number): void {
  assertSpatialAggregateCapacity(
    state.memberships,
    state.overflow,
    recordVersion,
    state.entries.length,
  );
}

function prepareEntries<Id, Owner extends object>(
  staged: readonly StagedReplacement<Id>[],
  ports: SpatialReplacementPreparationPorts<Id, Owner>,
): PreparedReplacement<Id>[] {
  return staged.map((entry, index) => prepareEntry(entry, index, ports));
}

async function prepareEntriesTimeSliced<Id, Owner extends object>(
  staged: readonly StagedReplacement<Id>[],
  ports: SpatialReplacementPreparationPorts<Id, Owner>,
  scheduler: SpatialReplacementPreparationScheduler,
): Promise<PreparedReplacement<Id>[] | "cancelled"> {
  const prepared: PreparedReplacement<Id>[] = [];
  for (let index = 0; index < staged.length; index += 1) {
    prepared.push(prepareEntry(staged[index]!, index, ports));
    if (!(await checkpoint(scheduler))) return "cancelled";
  }
  return prepared;
}

function prepareEntry<Id, Owner extends object>(
  staged: StagedReplacement<Id>,
  index: number,
  ports: SpatialReplacementPreparationPorts<Id, Owner>,
): PreparedReplacement<Id> {
  const membershipChanged = !hasSameCellMembership(staged.current, staged.range);
  return {
    current: staged.current,
    membershipChanged,
    range: staged.range,
    replacement: ports.createReplacement(
      staged.current,
      staged.bounds,
      staged.range,
      ports.recordVersion + index + 1,
      !membershipChanged,
    ),
  };
}

function finishPreparation<Id, Owner extends object>(
  prepared: readonly PreparedReplacement<Id>[],
  ports: SpatialReplacementPreparationPorts<Id, Owner>,
): PreparedSpatialReplacements<Id> {
  const extentHeap: BottomHeapEntry<Id>[] = [];
  for (const { replacement } of prepared) {
    if (!replacement.overflow) extentHeap.push(ports.extentEntry(replacement));
  }
  heapifyBottom(extentHeap);
  return createPreparedPlan(prepared, extentHeap, ports);
}

async function finishPreparationTimeSliced<Id, Owner extends object>(
  prepared: readonly PreparedReplacement<Id>[],
  ports: SpatialReplacementPreparationPorts<Id, Owner>,
  scheduler: SpatialReplacementPreparationScheduler,
): Promise<PreparedSpatialReplacements<Id> | "cancelled"> {
  const extentHeap: BottomHeapEntry<Id>[] = [];
  for (const { replacement } of prepared) {
    if (!replacement.overflow) extentHeap.push(ports.extentEntry(replacement));
    if (!(await checkpoint(scheduler))) return "cancelled";
  }
  if (prepared.length >= HEAPIFY_ADMISSION_SIZE || scheduler.shouldYield()) {
    await scheduler.yieldControl();
    if (scheduler.isCancelled?.() ?? false) return "cancelled";
  }
  heapifyBottom(extentHeap);
  return createPreparedPlan(prepared, extentHeap, ports);
}

function createPreparedPlan<Id, Owner extends object>(
  prepared: readonly PreparedReplacement<Id>[],
  extentHeap: BottomHeapEntry<Id>[],
  ports: SpatialReplacementPreparationPorts<Id, Owner>,
): PreparedSpatialReplacements<Id> {
  const state: PreparedSpatialState<Id, Owner> = {
    consumed: false,
    extentHeap,
    generation: ports.generation,
    owner: ports.owner,
    replacements: prepared,
    recordVersion: ports.recordVersion + prepared.length,
  };
  return Object.freeze({ replacementCount: prepared.length, [PREPARED_REPLACEMENTS]: state });
}

async function checkpoint(scheduler: SpatialReplacementPreparationScheduler): Promise<boolean> {
  if (scheduler.isCancelled?.() ?? false) return false;
  if (scheduler.shouldYield()) await scheduler.yieldControl();
  return !(scheduler.isCancelled?.() ?? false);
}
