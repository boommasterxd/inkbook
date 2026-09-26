import { describe, expect, it } from "vitest";

import {
  MAX_OVERFLOW_ELEMENTS,
  SpatialQueryScratch,
  UniformSpatialIndex,
} from "../../../../src/domain/spatial/index";

const near = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
const far = { minX: 1000, minY: 1000, maxX: 1010, maxY: 1010 };

describe("prepared spatial mutations", () => {
  it("keeps removal and replacement private until atomic commit", () => {
    const index = new UniformSpatialIndex<string>();
    index.insert("removed", near);
    index.insert("retained", near);
    const plan = index.prepareMutation(["removed"], [{ id: "inserted", bounds: far }]);
    expect(index.size).toBe(2);
    expect(query(index, near)).toEqual(expect.arrayContaining(["removed", "retained"]));
    plan.commit();
    expect(query(index, near)).toEqual(["retained"]);
    expect(query(index, far)).toEqual(["inserted"]);
    expect(() => plan.commit()).toThrow("stale");
  });

  it("rejects malformed additions before removing live entries", () => {
    const index = new UniformSpatialIndex<string>();
    index.insert("a", near);
    expect(() =>
      index.prepareMutation(["a"], [{ id: "b", bounds: { ...far, maxX: NaN } }]),
    ).toThrow();
    expect(query(index, near)).toEqual(["a"]);
    expect(() => index.prepareMutation(["missing"], [])).toThrow();
    expect(() => index.prepareMutation(["a", "a"], [])).toThrow();
    expect(() => index.prepareMutation([], [{ id: "a", bounds: near }])).toThrow();
  });

  it("checks final overflow capacity before removal and allows an equal-capacity swap", () => {
    const index = new UniformSpatialIndex<string>();
    const huge = { ...near, maxX: 1_000_000 };
    index.insertMany(
      Array.from({ length: MAX_OVERFLOW_ELEMENTS }, (_, id) => ({ id: String(id), bounds: huge })),
    );
    expect(() =>
      index.prepareMutation(
        ["0"],
        [
          { id: "next", bounds: huge },
          { id: "excess", bounds: huge },
        ],
      ),
    ).toThrow();
    expect(index.size).toBe(MAX_OVERFLOW_ELEMENTS);
    index.prepareMutation(["0"], [{ id: "next", bounds: huge }]).commit();
    expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS);
    expect(query(index, near)).toContain("next");
    expect(query(index, near)).not.toContain("0");
  });

  it("rejects a stale plan and owns the proposed bounds", () => {
    const index = new UniformSpatialIndex<string>();
    index.insert("a", near);
    const stale = index.prepareMutation(["a"], []);
    index.insert("b", far);
    expect(() => stale.commit()).toThrow("stale");
    const bounds = { ...far };
    const plan = index.prepareMutation(["a"], [{ id: "a", bounds }]);
    bounds.maxX = NaN;
    plan.commit();
    expect(query(index, far)).toEqual(expect.arrayContaining(["a", "b"]));
  });
});

function query(index: UniformSpatialIndex<string>, bounds: typeof near): string[] {
  const scratch = new SpatialQueryScratch<string>();
  index.query(bounds, scratch);
  return Array.from({ length: scratch.count }, (_, offset) => scratch.at(offset));
}
