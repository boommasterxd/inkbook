import { describe, expect, it, vi } from "vitest";

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

describe("time-sliced spatial mutations", () => {
  it("keeps a small edit local and cancels before publishing staged work", async () => {
    const index = new UniformSpatialIndex<string>();
    index.insert("a", near);
    index.insert("b", far);
    const entries = (index as unknown as { entries: Map<string, unknown> }).entries;
    const scan = vi.spyOn(entries, "values");
    const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };
    const local = await index.prepareMutationTimeSliced(["a"], [], scheduler);
    if (local === "cancelled") throw new Error("Expected a local plan.");
    expect(scan).not.toHaveBeenCalled();
    local.commit();
    expect(query(index, near)).toEqual([]);
    let cancelled = false;
    const cancelledPlan = await index.prepareMutationTimeSliced([], [{ id: "c", bounds: near }], {
      isCancelled: () => cancelled,
      shouldYield: () => true,
      yieldControl: async () => {
        cancelled = true;
      },
    });
    expect(cancelledPlan).toBe("cancelled");
    expect(index.size).toBe(1);
    scan.mockRestore();
  });

  it("rejects a stale bulk plan and restores overflow extent after publication", async () => {
    const index = new UniformSpatialIndex<number>();
    const huge = { ...near, maxX: 1_000_000 };
    index.insertMany(
      Array.from({ length: MAX_OVERFLOW_ELEMENTS }, (_, id) => ({ id, bounds: huge })),
    );
    const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };
    const stale = await index.prepareMutationTimeSliced([0, 1, 2], [], scheduler);
    if (stale === "cancelled") throw new Error("Expected a bulk plan.");
    index.insert(MAX_OVERFLOW_ELEMENTS, near);
    expect(() => stale.commit()).toThrow("stale");
    expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS);
    const current = await index.prepareMutationTimeSliced([0, 1, 2], [], scheduler);
    if (current === "cancelled") throw new Error("Expected a bulk plan.");
    current.commit();
    expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS - 3);
    expect(index.getMaximumBottom()).toBe(10);
    expect(index.size).toBe(MAX_OVERFLOW_ELEMENTS - 2);
    expect(query(index, near)).toEqual(expect.arrayContaining([3, MAX_OVERFLOW_ELEMENTS]));
  });

  it("cancels a partially built shadow without changing the live index", async () => {
    const index = new UniformSpatialIndex<number>();
    index.insertMany(
      Array.from({ length: 1_200 }, (_, id) => ({
        id,
        bounds: { ...near, minX: id * 256, maxX: id * 256 + 10 },
      })),
    );
    const entries = (index as unknown as { entries: Map<number, unknown> }).entries;
    const originalValues = entries.values.bind(entries);
    let shadowVisits = 0;
    const values = vi.spyOn(entries, "values").mockImplementation(function* () {
      for (const entry of originalValues()) {
        shadowVisits += 1;
        yield entry;
      }
      return undefined;
    });
    let cancelled = false;
    try {
      const result = await index.prepareMutationTimeSliced(
        Array.from({ length: 1_100 }, (_, id) => id + 100),
        [],
        {
          isCancelled: () => cancelled,
          shouldYield: () => shadowVisits >= 2,
          yieldControl: async () => {
            cancelled = true;
          },
        },
      );
      expect(result).toBe("cancelled");
      expect(shadowVisits).toBe(2);
      expect(index.size).toBe(1_200);
      expect(index.membershipCount).toBe(1_200);
      expect(index.getMaximumBottom()).toBe(10);
      expect(query(index, near)).toContain(0);
    } finally {
      values.mockRestore();
    }
  });
});

function query<Id>(index: UniformSpatialIndex<Id>, bounds: typeof near): Id[] {
  const scratch = new SpatialQueryScratch<Id>();
  index.query(bounds, scratch);
  return Array.from({ length: scratch.count }, (_, offset) => scratch.at(offset));
}
