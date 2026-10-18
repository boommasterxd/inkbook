import { vi } from "vitest";

import { SpatialSlots } from "../../../src/domain/spatial/slot-storage";

interface ObservedPage {
  entries: unknown[];
  readonly count: number;
}

export function createSpatialSlots(count: number): SpatialSlots<number> {
  const slots = new SpatialSlots<number>();
  for (let index = 0; index < count; index += 1) slots.set(index, index);
  return slots;
}

/** Observe actual page allocation and shallow copies, retaining no copied slot records. */
export function observeSlotPageCopies() {
  const NativeArray = Array;
  const created: number[] = [];
  const copied: number[] = [];
  vi.stubGlobal(
    "Array",
    new Proxy(NativeArray, {
      construct(target, args, newTarget) {
        created.push(Number(args[0]));
        return Reflect.construct(target, args, newTarget) as unknown[];
      },
    }),
  );
  const originalSlice = Reflect.get(NativeArray.prototype, "slice") as (
    this: unknown[],
    start?: number,
    end?: number,
  ) => unknown[];
  const slice = vi.spyOn(NativeArray.prototype, "slice").mockImplementation(function (
    this: unknown[],
    ...args
  ) {
    copied.push(this.length);
    slice.mockClear();
    return originalSlice.apply(this, args);
  });
  return {
    created,
    copied,
    reset: () => {
      created.length = 0;
      copied.length = 0;
    },
    restore: () => {
      slice.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

/** Proxy real indexed page accesses; setup traversal is excluded from the observation. */
export function observeSlotPageReads<Value>(slots: SpatialSlots<Value>) {
  const source = slots as unknown as { root: ObservedPage | undefined; capacity: number };
  const originals: { page: ObservedPage; entries: unknown[] }[] = [];
  let reads = 0;
  const wrap = (page: ObservedPage, divisor: number): void => {
    const entries = page.entries;
    if (divisor > 1) {
      for (const child of entries) {
        if (child !== undefined) wrap(child as ObservedPage, divisor / entries.length);
      }
    }
    originals.push({ page, entries });
    page.entries = new Proxy(entries, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/u.exec(key) !== null) reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
  };
  if (source.root !== undefined) wrap(source.root, source.capacity / 32);
  return {
    count: () => reads,
    reset: () => {
      reads = 0;
    },
    restore: () => {
      for (const { page, entries } of originals) page.entries = entries;
    },
  };
}
