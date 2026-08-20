/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact collection positions exercise path-copy boundaries. */
import { describe, expect, it } from "vitest";

import {
  PersistentMapV1,
  PersistentSequenceV1,
} from "../../../src/domain/scene";

const LARGE_COLLECTION_SIZE = 10_000;
const REPLACEMENT_INDEX = 4_321;
const NODE_PATH_BUDGET = 64;
const SPLICE_PATH_BUDGET = 256;

describe("PersistentMapV1", () => {
  it("iterates in Unicode code-point order instead of insertion or UTF-16 order", () => {
    const map = PersistentMapV1.fromEntries<string, number>([
      ["😀", 3],
      ["a", 1],
      ["\ue000", 2],
    ]);

    expect([...map.entriesByCanonicalKey()]).toEqual([
      ["a", 1],
      ["\ue000", 2],
      ["😀", 3],
    ]);
    expect(Object.isFrozen(map)).toBe(true);
  });

  it("path-copies only a logarithmic search path for one replacement", () => {
    const entries = Array.from(
      { length: LARGE_COLLECTION_SIZE },
      (_, index) =>
        [index.toString().padStart(5, "0"), Object.freeze({ index })] as const,
    );
    const map = PersistentMapV1.fromEntries(entries);
    const replacement = Object.freeze({ index: -1 });
    const updated = map.setWithStats(
      REPLACEMENT_INDEX.toString().padStart(5, "0"),
      replacement,
    );

    expect(updated.map).not.toBe(map);
    expect(updated.map.size).toBe(LARGE_COLLECTION_SIZE);
    expect(updated.map.get("00000")).toBe(map.get("00000"));
    expect(updated.map.get("09999")).toBe(map.get("09999"));
    expect(updated.stats.visitedNodes).toBeLessThan(NODE_PATH_BUDGET);
    expect(updated.stats.allocatedNodes).toBeLessThan(NODE_PATH_BUDGET);
  });

  it("deletes without rebuilding unaffected records", () => {
    const first = Object.freeze({ value: "first" });
    const last = Object.freeze({ value: "last" });
    const map = PersistentMapV1.fromEntries<
      string,
      Readonly<{ value: string }>
    >([
      ["a", first],
      ["b", Object.freeze({ value: "middle" })],
      ["c", last],
    ]);
    const deleted = map.deleteWithStats("b");

    expect(deleted.map.size).toBe(2);
    expect(deleted.map.has("b")).toBe(false);
    expect(deleted.map.get("a")).toBe(first);
    expect(deleted.map.get("c")).toBe(last);
  });
});

describe("PersistentSequenceV1", () => {
  it("supports logarithmic replacement without a flat replacement spine", () => {
    const sequence = PersistentSequenceV1.fromIterable(
      Array.from({ length: LARGE_COLLECTION_SIZE }, (_, index) => index),
    );
    const update = sequence.setWithStats(REPLACEMENT_INDEX, -1);

    expect(update.sequence).toHaveLength(LARGE_COLLECTION_SIZE);
    expect(update.sequence.get(REPLACEMENT_INDEX)).toBe(-1);
    expect(update.sequence.get(0)).toBe(0);
    expect(update.sequence.get(LARGE_COLLECTION_SIZE - 1)).toBe(
      LARGE_COLLECTION_SIZE - 1,
    );
    expect(update.stats.visitedNodes).toBeLessThan(NODE_PATH_BUDGET);
    expect(update.stats.allocatedNodes).toBeLessThan(NODE_PATH_BUDGET);
  });

  it("splices and moves bounded ranges through path-copy splits and joins", () => {
    const sequence = PersistentSequenceV1.fromIterable(["a", "b", "c", "d"]);
    const spliced = sequence.spliceWithStats(1, 2, ["x", "y", "z"]);
    const moved = spliced.sequence.moveWithStats(1, 2, 3);

    expect([...spliced.sequence.values()]).toEqual(["a", "x", "y", "z", "d"]);
    expect([...moved.sequence.values()]).toEqual(["a", "z", "d", "x", "y"]);
    expect(spliced.stats.allocatedNodes).toBeLessThan(SPLICE_PATH_BUDGET);
    expect(moved.stats.allocatedNodes).toBeLessThan(SPLICE_PATH_BUDGET);
  });

  it("preserves every item across deterministic mixed updates", () => {
    let sequence = PersistentSequenceV1.fromIterable<number>([]);
    const expected: number[] = [];
    for (let value = 0; value < 100; value += 1) {
      const index = value % (expected.length + 1);
      expected.splice(index, 0, value);
      sequence = sequence.spliceWithStats(index, 0, [value]).sequence;
    }
    for (let count = 0; count < 25; count += 1) {
      const index = count % expected.length;
      expected.splice(index, 1);
      sequence = sequence.spliceWithStats(index, 1, []).sequence;
    }

    expect([...sequence.values()]).toEqual(expected);
    expect(sequence).toHaveLength(expected.length);
  });
});
