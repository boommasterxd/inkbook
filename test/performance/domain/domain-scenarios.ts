import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { moveSelectionTimeSliced } from "../../../src/editor/selection/transforms";
import type { UniformSpatialIndex } from "../../../src/domain/spatial/index";
import type { CellColumns, IndexedEntry } from "../../../src/domain/spatial/index-state";
import { SpatialMap } from "../../../src/domain/spatial/spatial-map";
import type { SpatialSlots } from "../../../src/domain/spatial/slot-storage";
import {
  ActiveEditorHistory,
  type ActiveEditorHistoryModel,
} from "../../../src/obsidian/embeds/active-editor/history";

export class CheckpointSliceScheduler {
  readonly #checkpointCounts: number[] = [];
  #checkpoints = 0;
  #state: "active" | "yielding" | "finished" = "active";

  public constructor(
    public readonly checkpointLimit = 40,
    private readonly onYield: () => void = () => undefined,
  ) {
    if (!Number.isSafeInteger(checkpointLimit) || checkpointLimit <= 0) {
      throw new RangeError("Checkpoint limits must be positive safe integers.");
    }
  }

  public shouldYield = (): boolean => {
    this.#requireActive();
    this.#checkpoints += 1;
    return this.#checkpoints >= this.checkpointLimit;
  };

  public yieldControl = async (): Promise<void> => {
    this.#requireActive();
    this.#recordSlice();
    this.#state = "yielding";
    try {
      this.onYield();
      await Promise.resolve();
    } finally {
      this.#state = "active";
    }
  };

  public finish(): void {
    if (this.#state === "finished") return;
    this.#requireActive();
    this.#recordSlice();
    this.#state = "finished";
  }

  public get checkpointCounts(): readonly number[] {
    return this.#checkpointCounts;
  }

  #requireActive(): void {
    if (this.#state !== "active") throw new Error(`Slice scheduler is ${this.#state}.`);
  }

  #recordSlice(): void {
    this.#checkpointCounts.push(this.#checkpoints);
    this.#checkpoints = 0;
  }
}

export async function exerciseTransformRun(
  store: ElementStore,
  history: ActiveEditorHistory,
  strokeIds: readonly string[],
  operationCount: number,
  onYield?: (stableId: string, stableRecord: ReturnType<ElementStore["get"]>) => void,
): Promise<{
  maximumRetainedHistoryBytes: number;
  checkpointCounts: readonly number[];
  yieldsPerOperation: readonly number[];
}> {
  let maximumRetainedHistoryBytes = history.retainedPayloadBytes;
  const checkpointCounts: number[] = [];
  const yieldsPerOperation: number[] = [];
  for (let operation = 0; operation < operationCount; operation += 1) {
    const elements = strokeIds.map((id) => requireStroke(store, id));
    const stableId = strokeIds[0] as string;
    const stableRecord = store.get(stableId);
    let yields = 0;
    const scheduler = new CheckpointSliceScheduler(40, () => {
      yields += 1;
      onYield?.(stableId, stableRecord);
    });
    const distance = operation % 2 === 0 ? 0.001 : -0.001;
    const moved = await moveSelectionTimeSliced(elements, { x: distance, y: distance }, scheduler);
    if (moved === null || !moved.every(isStroke)) {
      throw new Error("Transform unexpectedly cancelled or changed element kinds.");
    }
    const prepared = await store.prepareElementReplacement(moved, scheduler);
    if (prepared.status !== "prepared" || prepared.token === null) {
      throw new Error("Transform failed to prepare its atomic replacement.");
    }
    const result = store.commitPreparedElementReplacement(prepared.token);
    scheduler.finish();
    yieldsPerOperation.push(yields);
    if (
      !history.registerAppliedReplacement(elements, moved, {
        redo: () => commitStrokeState(store, moved),
        undo: () => commitStrokeState(store, elements),
      })
    )
      throw new Error("Transform failed to retain its history command.");
    checkpointCounts.push(...scheduler.checkpointCounts);
    maximumRetainedHistoryBytes = Math.max(
      maximumRetainedHistoryBytes,
      history.retainedPayloadBytes,
    );
    if (result.status !== "committed" || result.delta?.changes.length !== strokeIds.length) {
      throw new Error("Transform did not publish one complete atomic delta.");
    }
  }
  return { maximumRetainedHistoryBytes, checkpointCounts, yieldsPerOperation };
}

async function commitStrokeState(
  store: ElementStore,
  elements: readonly StrokeElementV1[],
): Promise<boolean> {
  const prepared = await store.prepareElementReplacement(elements, new CheckpointSliceScheduler());
  return (
    prepared.token !== null &&
    store.commitPreparedElementReplacement(prepared.token).status === "committed"
  );
}

export function createNoopHistoryModel(): ActiveEditorHistoryModel {
  return {
    commitBandOrder: () => undefined,
    commitElements: () => undefined,
    commitPage: () => undefined,
    removeElements: () => undefined,
    replaceElements: () => undefined,
  };
}

export function requireStroke(store: ElementStore, id: string): StrokeElementV1 {
  const element = store.get(id)?.element;
  if (element?.kind !== "stroke") throw new Error(`Expected stroke fixture record: ${id}`);
  return element as unknown as StrokeElementV1;
}

function isStroke(element: InkElementV1): element is StrokeElementV1 {
  return element.kind === "stroke";
}

/** Count real grid lookups/iterator entries and indexed slot reads, excluding fixture setup. */
export function observeSpatialQueryWork(
  index: UniformSpatialIndex<number>,
  spyOn: typeof import("vitest").vi.spyOn,
) {
  const source = index as unknown as {
    cells: CellColumns;
    slots: SpatialSlots<IndexedEntry<number>>;
  };
  const maps = new WeakSet<object>([source.cells, ...source.cells.values()]);
  const counts = { columns: 0, cells: 0, slots: 0 };
  const visit = (map: object) => {
    if (map === source.cells) counts.columns += 1;
    else if (maps.has(map)) counts.cells += 1;
  };
  const originalGet = Reflect.get(SpatialMap.prototype, "get") as (
    this: SpatialMap<unknown, unknown>,
    key: unknown,
  ) => unknown;
  const get = spyOn(SpatialMap.prototype, "get").mockImplementation(function (
    this: SpatialMap<unknown, unknown>,
    key: unknown,
  ) {
    visit(this);
    return originalGet.call(this, key);
  });
  const entries = observeSpatialMapEntries(visit, spyOn);
  const originalSlotGet = source.slots.get.bind(source.slots);
  const slots = spyOn(source.slots, "get").mockImplementation((slot) => {
    counts.slots += 1;
    return originalSlotGet(slot);
  });
  const comparisons = observeSpatialComparisons(source.cells, spyOn);
  const maximumHeight = 2 * Math.ceil(Math.log2(Math.max(index.size, index.membershipCount) + 1));
  return {
    counts,
    comparisonsPerLookupBound: maximumHeight,
    comparisons: comparisons.count,
    reset: () => {
      Object.assign(counts, { columns: 0, cells: 0, slots: 0 });
      comparisons.reset();
    },
    restore: () => {
      slots.mockRestore();
      get.mockRestore();
      entries.forEach((spy) => spy.mockRestore());
      comparisons.restore();
    },
  };
}

function observeSpatialMapEntries(
  visit: (map: object) => void,
  spyOn: typeof import("vitest").vi.spyOn,
) {
  const original = Reflect.get(SpatialMap.prototype, "entries") as (
    this: SpatialMap<unknown, unknown>,
  ) => MapIterator<[unknown, unknown]>;
  const observed = function* (
    this: SpatialMap<unknown, unknown>,
  ): Generator<[unknown, unknown], undefined> {
    for (const entry of original.call(this)) {
      visit(this);
      yield entry;
    }
    return undefined;
  };
  return [
    spyOn(SpatialMap.prototype, "entries").mockImplementation(observed),
    spyOn(SpatialMap.prototype, Symbol.iterator).mockImplementation(observed),
  ];
}

export function observeSpatialComparisons(
  cells: CellColumns,
  spyOn: typeof import("vitest").vi.spyOn,
) {
  const order = (cells as unknown as { order: object }).order;
  const prototype = Object.getPrototypeOf(order) as {
    compare: (first: unknown, second: unknown) => number;
  };
  const original = prototype.compare;
  let comparisons = 0;
  const compare = spyOn(prototype, "compare").mockImplementation(function (
    this: typeof prototype,
    ...args
  ) {
    comparisons += 1;
    return original.apply(this, args);
  });
  return {
    count: () => comparisons,
    reset: () => {
      comparisons = 0;
    },
    restore: () => compare.mockRestore(),
  };
}
