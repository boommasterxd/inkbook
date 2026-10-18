import { describe, expect, it } from "vitest";

import { SpatialSlots } from "../../../../src/domain/spatial/slot-storage";

describe("spatial slot pages", () => {
  it("retains sparse values across page and root growth boundaries", () => {
    const slots = new SpatialSlots<string>();
    const addresses = [
      0,
      31,
      32,
      1_023,
      1_024,
      32_767,
      32_768,
      262_655,
      Number.MAX_SAFE_INTEGER - 1,
    ];
    for (const slot of addresses) slots.set(slot, String(slot));
    for (const slot of addresses) expect(slots.get(slot)).toBe(String(slot));
    for (const slot of [1, 30, 33, 1_022, 1_025, 32_766, 262_656])
      expect(slots.get(slot)).toBeUndefined();
    expect(slots.length).toBe(Number.MAX_SAFE_INTEGER);
    for (const slot of addresses) slots.set(slot, undefined);
    expect(slots.length).toBe(Number.MAX_SAFE_INTEGER);
    expect((slots as unknown as { root: unknown }).root).toBeUndefined();
    slots.set(0, "reused");
    expect(slots.get(0)).toBe("reused");
    expect(slots.get(262_655)).toBeUndefined();
  });

  it("keeps separate ownership through repeated forks, root growth, pruning and reuse", () => {
    const original = new SpatialSlots<object>();
    const firstValue = {};
    const boundaryValue = {};
    original.set(0, firstValue);
    original.set(31, boundaryValue);
    const first = original.fork();
    first.set(32_768, { first: true });
    first.set(0, { changed: true });
    const second = first.fork();
    const third = original.fork();
    original.set(31, undefined);
    first.set(31, undefined);
    second.set(0, undefined);
    third.set(1_024, { third: true });
    expect(original.get(0)).toBe(firstValue);
    expect(original.get(31)).toBeUndefined();
    expect(second.get(31)).toBe(boundaryValue);
    expect(second.get(0)).toBeUndefined();
    expect(first.get(0)).toEqual({ changed: true });
    expect(first.get(32_768)).toEqual({ first: true });
    expect(original.get(32_768)).toBeUndefined();
    expect(third.get(31)).toBe(boundaryValue);
    expect(third.get(1_024)).toEqual({ third: true });
    expect(original.get(1_024)).toBeUndefined();
    second.set(32_768, undefined);
    second.set(31, undefined);
    expect((second as unknown as { root: unknown }).root).toBeUndefined();
    second.set(31, firstValue);
    expect(second.get(31)).toBe(firstValue);
    expect(first.get(31)).toBeUndefined();
  });

  it("extends length for vacant removals without allocating or retaining a page", () => {
    const slots = new SpatialSlots<number>();
    slots.set(1_024, undefined);
    expect(slots.length).toBe(1_025);
    expect((slots as unknown as { root: unknown }).root).toBeUndefined();
    slots.set(0, 1);
    slots.set(32_768, undefined);
    expect(slots.length).toBe(32_769);
    expect(slots.get(0)).toBe(1);
    slots.set(1, undefined);
    expect(slots.get(0)).toBe(1);
    slots.set(0, undefined);
    expect((slots as unknown as { root: unknown }).root).toBeUndefined();
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid write address %s before changing values or length",
    (address) => {
      const slots = new SpatialSlots<number>();
      slots.set(0, 42);
      expect(() => slots.set(address, 1)).toThrow(RangeError);
      expect(slots.length).toBe(1);
      expect(slots.get(0)).toBe(42);
      expect(slots.get(address)).toBeUndefined();
    },
  );
});
