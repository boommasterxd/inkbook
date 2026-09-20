import { describe, expect, it } from "vitest";
import { ElementOrderTree } from "../../../../src/domain/store/element-order-tree";

function expectOrder(tree: ElementOrderTree, model: readonly string[]): void {
  expect([...tree.ids()]).toEqual(model);
  expect(tree.size).toBe(model.length);
  model.forEach((id, rank) => {
    expect(tree.at(rank)).toBe(id);
    expect(tree.rankOf(id)).toBe(rank);
  });
}

describe("ElementOrderTree", () => {
  it("rejects invalid insertions without modifying the sequence and supports reuse", () => {
    const tree = new ElementOrderTree();
    expect(tree.at(0)).toBeUndefined();
    expect(tree.rankOf("missing")).toBeUndefined();
    expect(tree.remove("missing")).toBe(false);
    tree.insert("a", 0);
    expect(() => tree.insert("a", 0)).toThrow("Duplicate");
    for (const rank of [-1, 2, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => tree.insert("b", rank)).toThrow(RangeError);
      expect(tree.at(rank)).toBeUndefined();
    }
    expectOrder(tree, ["a"]);
    tree.clear();
    expectOrder(tree, []);
    expect(tree.rankOf("a")).toBeUndefined();
    tree.insert("a", 0);
    expect(tree.remove("a")).toBe(true);
    expectOrder(tree, []);
  });

  it("matches a sequence through deterministic mixed insertion, deletion and reinsertion", () => {
    const tree = new ElementOrderTree();
    const model: string[] = [];
    let seed = 4711;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let step = 0; step < 1500; step += 1) {
      if (model.length > 0 && random() < 0.45) {
        const rank = Math.floor(random() * model.length);
        const [id] = model.splice(rank, 1);
        expect(tree.remove(id!)).toBe(true);
      } else {
        const rank = Math.floor(random() * (model.length + 1));
        const id = `element-${step}`;
        model.splice(rank, 0, id);
        tree.insert(id, rank);
      }
      expectOrder(tree, model);
    }
    while (model.length > 0) {
      const rank = Math.floor(random() * model.length);
      const [id] = model.splice(rank, 1);
      expect(tree.remove(id!)).toBe(true);
      expectOrder(tree, model);
    }
  });
});
