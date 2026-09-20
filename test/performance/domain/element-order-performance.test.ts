import { describe, expect, it } from "vitest";
import { ElementOrderTree } from "../../../src/domain/store/element-order-tree";
import { ElementStore } from "../../../src/domain/store/public";
import { createStandardDomainFixture } from "./standard-domain-fixture";

describe("element ordering work", () => {
  it.each(["prepend", "append"] as const)(
    "bounds actual visits for a 10000-element %s sequence",
    (mode) => {
      const tree = new ElementOrderTree();
      // An AVL height is below 1.45 log2(n + 2). Include traversal, ancestors,
      // successor lookup and up to two rotations per ancestor conservatively.
      const heightBound = Math.ceil(1.45 * Math.log2(10002));
      for (let index = 0; index < 10000; index += 1) {
        tree.resetInstrumentation();
        tree.insert(String(index), mode === "append" ? tree.size : 0);
        expect(tree.nodeVisits).toBeLessThanOrEqual(8 * heightBound);
      }
      for (const rank of [0, 4999, 9999]) {
        tree.resetInstrumentation();
        const id = tree.at(rank)!;
        expect(tree.rankOf(id)).toBe(rank);
        expect(tree.nodeVisits).toBeLessThanOrEqual(2 * heightBound);
      }
      for (let index = 0; index < 10000; index += 1) {
        tree.resetInstrumentation();
        expect(tree.remove(String(index))).toBe(true);
        expect(tree.nodeVisits).toBeLessThanOrEqual(8 * heightBound);
      }
      expect([...tree.ids()]).toEqual([]);
      tree.insert("reused", 0);
      expect([...tree.ids()]).toEqual(["reused"]);
    },
  );

  it("removes one stroke without visiting unrelated order entries or emitting their deltas", () => {
    const fixture = createStandardDomainFixture();
    // Keep the full 10,000-stroke/500,000-point capacity and compare a small document.
    for (const count of [100, 10000]) {
      const store = new ElementStore(fixture.elements.slice(0, count));
      const removed = fixture.strokeIds[0]!;
      const untouched = fixture.strokeIds[count - 1]!;
      const previous = store.get(untouched);
      store.resetInstrumentation();
      const delta = store.remove([removed]);
      expect(delta?.changes.map(({ id }) => id)).toEqual([removed]);
      expect(store.size).toBe(count - 1);
      expect(store.get(removed)).toBeUndefined();
      expect(store.get(untouched)).toBe(previous);
      const work = store.instrumentation;
      expect(work.fullStoreScans).toBe(0);
      expect(work.bandScans).toBe(0);
      expect(work.deltaEntries).toBe(1);
      // Includes ancestor repair, successor search and conservative AVL rotations.
      expect(work.orderNodeVisits).toBeGreaterThan(0);
      expect(work.orderNodeVisits).toBeLessThanOrEqual(8 * Math.ceil(1.45 * Math.log2(count + 2)));
    }
  });
});
