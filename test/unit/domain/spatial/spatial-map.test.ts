import { describe, expect, it } from "vitest";

import { SpatialMap } from "../../../../src/domain/spatial/spatial-map";
import { SpatialFreeSlots, SpatialSlots } from "../../../../src/domain/spatial/slot-storage";
import { SpatialQueryScratch, UniformSpatialIndex } from "../../../../src/domain/spatial";

interface ObservedNode {
  readonly height: number;
  readonly left: ObservedNode | undefined;
  readonly right: ObservedNode | undefined;
}

function expectBalanced(node: ObservedNode | undefined): number {
  if (node === undefined) return 0;
  const left = expectBalanced(node.left);
  const right = expectBalanced(node.right);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  expect(node.height).toBe(Math.max(left, right) + 1);
  return node.height;
}

describe("persistent spatial storage", () => {
  it.each([false, true])(
    "preserves Map order while balancing and deleting reversed=%s",
    (reversed) => {
      const keys = Array.from({ length: 128 }, (_, key) => key);
      if (reversed) keys.reverse();
      const expected = new Map<number, number>();
      const actual = new SpatialMap<number, number>();
      for (const key of keys) {
        actual.set(key, key * 2);
        expected.set(key, key * 2);
      }
      const fork = actual.fork();
      for (const key of keys.filter((key) => key % 3 !== 0)) {
        expect(fork.delete(key)).toBe(expected.delete(key));
        expect(fork.delete(key)).toBe(false);
      }
      fork.set(6, -1).set(200, 1).set(1, 3);
      expected.set(6, -1).set(200, 1).set(1, 3);
      expect([...fork]).toEqual([...expected]);
      expect([...fork.keys()]).toEqual([...expected.keys()]);
      expect([...fork.values()]).toEqual([...expected.values()]);
      expect(fork.size).toBe(expected.size);
      expect([...actual.keys()]).toEqual(keys);
      expect(actual.get(6)).toBe(12);
      expect(fork.get(6)).toBe(-1);
      expect(fork.get(201)).toBeUndefined();
      const trees = fork as unknown as { root: ObservedNode; ordered: ObservedNode };
      expect(expectBalanced(trees.root)).toBeLessThanOrEqual(
        2 * Math.ceil(Math.log2(fork.size + 1)),
      );
      expectBalanced(trees.ordered);
      for (const key of [...expected.keys()]) fork.delete(key);
      expect(fork.size).toBe(0);
      expect([...fork]).toEqual([]);
    },
  );
});

describe("spatial key identity", () => {
  it("separates primitive and identity keys while sharing a safe identity order across forks", () => {
    const object = {};
    const keys = ["1", 1, 1n, null, undefined, false, true, NaN, object, {}, () => 1];
    const map = new SpatialMap<unknown, number>();
    keys.forEach((key, offset) => map.set(key, offset));
    map.set(NaN, 100);
    map.set(-0, 200);
    expect(map.get(0)).toBe(200);
    expect(map.get(NaN)).toBe(100);
    expect(map.get({})).toBeUndefined();
    expect(() => map.get(Symbol("slot"))).toThrow("symbol");
    expect(() => map.set(Symbol("slot"), 1)).toThrow("symbol");
    expect(() => map.delete(Symbol("slot"))).toThrow("symbol");
    const fork = map.fork();
    fork.delete(object);
    fork.set("1", 300);
    expect(map.get(object)).toBe(8);
    expect(map.get("1")).toBe(0);
    expect(fork.get("1")).toBe(300);
    expect([...fork.keys()]).toEqual([...keys.filter((key) => key !== object), 0]);
  });

  it("rejects symbol IDs before publishing a spatial mutation", () => {
    const index = new UniformSpatialIndex<unknown>();
    const bounds = { minX: 1, minY: 1, maxX: 2, maxY: 2 };
    const symbol = Symbol("unsupported");
    index.insert("retained", bounds);
    expect(() => index.prepareMutation(["retained"], [{ id: symbol, bounds }])).toThrow("symbol");
    expect(() => index.insert(symbol, bounds)).toThrow("symbol");
    expect(() => index.remove(symbol)).toThrow("symbol");
    expect(index.size).toBe(1);
    const scratch = new SpatialQueryScratch<unknown>();
    expect(index.query(bounds, scratch)).toBe(1);
    expect(scratch.at(0)).toBe("retained");
    scratch.release();
  });

  it.each([
    [NaN, -Infinity, -0, 1, Infinity],
    [Infinity, 1, 0, -Infinity, NaN],
  ])("preserves numeric key lookup and deletion for insertion order %j", (...keys) => {
    const map = new SpatialMap<number, number>();
    const expected = new Map<number, number>();
    keys.forEach((key, value) => {
      map.set(key, value);
      expected.set(key, value);
    });
    map.set(NaN, 10).set(-0, 20);
    expected.set(NaN, 10).set(-0, 20);
    expect([...map]).toEqual([...expected]);
    for (const key of [NaN, -Infinity, -0, 0, 1, Infinity]) {
      expect(map.get(key)).toBe(expected.get(key));
    }
    for (const key of keys) {
      expect(map.delete(key)).toBe(expected.delete(key));
      expect([...map]).toEqual([...expected]);
    }
  });

  it("preserves identity and insertion order beyond the safe-integer lifetime boundary", () => {
    const map = new SpatialMap<object, number>();
    const state = map as unknown as { nextOrdinal: bigint; order: { nextIdentity: bigint } };
    state.nextOrdinal = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    state.order.nextIdentity = state.nextOrdinal;
    const first = {};
    const second = {};
    const third = {};
    const fourth = {};
    map.set(first, 1).set(second, 2);
    const fork = map.fork();
    fork.set(third, 3).set(first, 4);
    map.set(fourth, 5);
    expect([...map.values()]).toEqual([1, 2, 5]);
    expect([...fork.keys()]).toEqual([first, second, third]);
    expect(map.get(third)).toBeUndefined();
    expect(fork.get(fourth)).toBeUndefined();
    expect(fork.get(first)).toBe(4);
    expect(fork.get(second)).toBe(2);
    expect(fork.delete(second)).toBe(true);
    expect(map.get(second)).toBe(2);
  });
});

describe("spatial storage ownership", () => {
  it("does not expose stored entry tuples through public iteration", () => {
    const map = new SpatialMap<number, string>();
    map.set(1, "retained");
    const fork = map.fork();
    const pair = map.entries().next().value!;
    pair[0] = 99;
    pair[1] = "changed";
    expect([...map]).toEqual([[1, "retained"]]);
    expect([...fork]).toEqual([[1, "retained"]]);
    const forkPair = fork[Symbol.iterator]().next().value!;
    forkPair[1] = "fork alias";
    expect([...fork.values()]).toEqual(["retained"]);
    expect([...map.keys()]).toEqual([1]);
  });

  it("starts iteration lazily and preserves an interrupted iterator across an isolated fork", () => {
    const map = new SpatialMap<number, string>();
    map.set(1, "first");
    const iterator = map.entries();
    map.set(2, "second");
    expect(iterator.next().value).toEqual([1, "first"]);
    const fork = map.fork();
    fork.set(2, "fork");
    map.set(3, "later");
    expect(iterator.next().value).toEqual([2, "second"]);
    iterator.return?.();
    expect(iterator.next().done).toBe(true);
    expect([...fork.values()]).toEqual(["first", "fork"]);
  });

  it("handles alternating insertion paths and stores undefined values without confusing absence", () => {
    const map = new SpatialMap<number, number | undefined>();
    for (const key of [8, 4, 6, 2, 3, 10, 9, 14, 12, 13, 1, 5, 7, 11]) map.set(key, key);
    map.set(15, undefined);
    expect(map.size).toBe(15);
    expect(map.delete(15)).toBe(true);
    const state = map as unknown as { root: ObservedNode; ordered: ObservedNode };
    expectBalanced(state.root);
    expectBalanced(state.ordered);
    for (const key of [8, 4, 6, 2, 3, 10, 9, 14, 12, 13, 1, 5, 7, 11]) {
      expect(map.delete(key)).toBe(true);
      expectBalanced(state.root);
      expectBalanced(state.ordered);
    }
  });

  it("forks slot and free-slot ownership without retaining chains of earlier storage roots", () => {
    const slots = new SpatialSlots<string>();
    const free = new SpatialFreeSlots();
    slots.set(100, "retained");
    free.push(1);
    free.push(2);
    const stagedSlots = slots.fork();
    const stagedFree = free.fork();
    stagedSlots.set(100, undefined);
    stagedSlots.set(5, "new");
    stagedFree.push(100);
    expect(slots.length).toBe(101);
    expect(slots.get(100)).toBe("retained");
    expect(slots.get(5)).toBeUndefined();
    expect(stagedSlots.get(100)).toBeUndefined();
    expect(stagedSlots.get(5)).toBe("new");
    expect(stagedFree.pop()).toBe(100);
    expect(stagedFree.pop()).toBe(2);
    expect(stagedFree.pop()).toBe(1);
    expect(stagedFree.pop()).toBeUndefined();
    expect(free.pop()).toBe(2);
  });
});

it("keeps nested value ownership distinct from copied node ownership across multiple forks", () => {
  type Column = SpatialMap<string, SpatialMap<number, number>>;
  const bucket = new SpatialMap<number, number>().set(1, 1);
  const column = new SpatialMap<string, SpatialMap<number, number>>().set("row", bucket);
  const original = new SpatialMap<string, Column>().set("column", column);
  const first = original.fork();
  first.set("unrelated", new SpatialMap());
  const write = (outer: SpatialMap<string, Column>, value: number) => {
    const ownedColumn = outer.getForUpdate("column", (current) => current.fork())!;
    const ownedBucket = ownedColumn.getForUpdate("row", (current) => current.fork())!;
    ownedBucket.set(1, value);
  };
  write(first, 2);
  expect(original.get("column")!.get("row")!.get(1)).toBe(1);
  const second = first.fork();
  write(first, 3);
  write(second, 4);
  write(original, 5);
  expect(first.get("column")!.get("row")!.get(1)).toBe(3);
  expect(second.get("column")!.get("row")!.get(1)).toBe(4);
  expect(original.get("column")!.get("row")!.get(1)).toBe(5);
  expect(second.getForUpdate("absent", (current) => current.fork())).toBeUndefined();
});
