import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { moveSelectionTimeSliced } from "../../../src/editor/selection/transforms";
import type { UniformSpatialIndex } from "../../../src/domain/spatial/index";
import type { CellColumns, IndexedEntry } from "../../../src/domain/spatial/index-state";
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
    slots: (IndexedEntry<number> | undefined)[];
  };
  const maps = new WeakSet<object>([source.cells, ...source.cells.values()]);
  const originalSlots = source.slots;
  const counts = { columns: 0, cells: 0, slots: 0 };
  const visit = (map: object) => {
    if (map === source.cells) counts.columns += 1;
    else if (maps.has(map)) counts.cells += 1;
  };
  const originalGet = Reflect.get(Map.prototype, "get") as (
    this: Map<unknown, unknown>,
    key: unknown,
  ) => unknown;
  const get = spyOn(Map.prototype, "get").mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
  ) {
    visit(this);
    return originalGet.call(this, key);
  });
  const entries = observeSpatialMapEntries(visit, spyOn);
  source.slots = new Proxy(originalSlots, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/u.test(key)) counts.slots += 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  return {
    counts,
    reset: () => Object.assign(counts, { columns: 0, cells: 0, slots: 0 }),
    restore: () => {
      source.slots = originalSlots;
      get.mockRestore();
      entries.forEach((spy) => spy.mockRestore());
    },
  };
}

function observeSpatialMapEntries(
  visit: (map: object) => void,
  spyOn: typeof import("vitest").vi.spyOn,
) {
  const original = Reflect.get(Map.prototype, "entries") as (
    this: Map<unknown, unknown>,
  ) => MapIterator<[unknown, unknown]>;
  const observed = function* (
    this: Map<unknown, unknown>,
  ): Generator<[unknown, unknown], undefined> {
    for (const entry of original.call(this)) {
      visit(this);
      yield entry;
    }
    return undefined;
  };
  return [
    spyOn(Map.prototype, "entries").mockImplementation(observed),
    spyOn(Map.prototype, Symbol.iterator).mockImplementation(observed),
  ];
}
