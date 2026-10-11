import { describe, expect, it, vi } from "vitest";
import * as bottomHeap from "../../../../src/domain/spatial/max-bottom-heap";

import {
  MAX_OVERFLOW_ELEMENTS,
  MAX_SPATIAL_MEMBERSHIPS,
  SpatialQueryScratch,
  UniformSpatialIndex,
} from "../../../../src/domain/spatial/index";
import type { SpatialBounds } from "../../../../src/domain/spatial/bounds";

const near = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
const far = { minX: 1000, minY: 1000, maxX: 1010, maxY: 1010 };
const maximumGrid = { ...near, maxX: 65_535 };

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

describe("shadow heap cancellation", () => {
  it.each(["cancelled", "stale"])("discards %s preparation during the heap build", async (mode) => {
    const index = new UniformSpatialIndex<number>();
    const inserted = Array.from({ length: 1_200 }, (_, id) => ({
      id,
      bounds: { ...near, minY: id, maxY: id + 10 },
    }));
    index.insertMany(inserted);
    const heapify = vi.spyOn(bottomHeap, "heapifyBottomAt");
    let cancelled = false;
    try {
      const result = await index.prepareMutationTimeSliced(
        inserted.map(({ id }) => id),
        inserted,
        {
          isCancelled: () => cancelled,
          shouldYield: () => heapify.mock.calls.length > 0,
          yieldControl: async () => {
            expect(index.size).toBe(1_200);
            expect(index.getMaximumBottom()).toBe(1_209);
            if (mode === "cancelled") cancelled = true;
            else index.insert(1_200, far);
          },
        },
      );
      expect(result).toBe("cancelled");
      expect(heapify).toHaveBeenCalledTimes(1);
      expect(index.size).toBe(mode === "cancelled" ? 1_200 : 1_201);
      expect(index.getMaximumBottom()).toBe(1_209);
      expect(query(index, near)).toContain(0);
    } finally {
      heapify.mockRestore();
    }
  });
});

describe("sliced spatial capacity and full-removal validation", () => {
  it("validates full-removal IDs before skipping enumeration and retains insertion order", async () => {
    const index = new UniformSpatialIndex<number>();
    const ids = Array.from({ length: 1_200 }, (_, id) => id);
    index.insertMany(ids.map((id) => ({ id, bounds: near })));
    const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };
    await expect(
      index.prepareMutationTimeSliced([...ids.slice(1), 1], [], scheduler),
    ).rejects.toThrow("Duplicate");
    await expect(
      index.prepareMutationTimeSliced([...ids.slice(1), 1_200], [], scheduler),
    ).rejects.toThrow("does not contain");
    expect(query(index, near)).toEqual(ids);
    const entries = (index as unknown as { entries: Map<number, unknown> }).entries;
    const scan = vi.spyOn(entries, "values");
    try {
      const restored = await index.prepareMutationTimeSliced(
        ids,
        [...ids].reverse().map((id) => ({ id, bounds: near })),
        scheduler,
      );
      if (restored === "cancelled") throw new Error("Expected a complete replacement.");
      expect(scan).not.toHaveBeenCalled();
      expect(query(index, near)).toEqual(ids);
      restored.commit();
      expect(query(index, near)).toEqual([...ids].reverse());
      expect(index.getMaximumBottom()).toBe(10);
    } finally {
      scan.mockRestore();
    }
  });

  it("preflights sliced overflow capacity and restores mixed grid and overflow extents", async () => {
    const index = createOverflowIndex(30);
    const huge = { ...near, maxX: 1_000_000, maxY: 30 };
    const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };
    await expect(
      index.prepareMutationTimeSliced([], [{ id: -1, bounds: huge }], scheduler),
    ).rejects.toThrow(RangeError);
    expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS);
    const plan = await index.prepareMutationTimeSliced(
      [0, 1, 2],
      [
        { id: 0, bounds: far },
        { id: 1, bounds: near },
      ],
      scheduler,
    );
    if (plan === "cancelled") throw new Error("Expected a mixed shadow.");
    plan.commit();
    expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS - 3);
    expect(index.membershipCount).toBe(2);
    expect(index.extentHeapEntryCount).toBe(2);
    expect(index.getMaximumBottom()).toBe(1_010);
    const removal = await index.prepareMutationTimeSliced([0], [], scheduler);
    if (removal === "cancelled") throw new Error("Expected extent removal.");
    removal.commit();
    expect(index.getMaximumBottom()).toBe(30);
    expect(query(index, near)).not.toContain(2);
  });
});

describe("atomic spatial mutation selection", () => {
  it.each([1_024, 1_025])(
    "preserves the atomic selection boundary at %i memberships",
    async (work) => {
      const index = new UniformSpatialIndex<number>();
      index.insertMany([
        ...Array.from({ length: 4 }, (_, id) => ({ id, bounds: maximumGrid })),
        { id: 4, bounds: near },
        { id: 5, bounds: far },
      ]);
      const entries = (index as unknown as { entries: Map<number, unknown> }).entries;
      const scan = vi.spyOn(entries, "values");
      try {
        const removed = Array.from({ length: work === 1_024 ? 4 : 5 }, (_, id) => id);
        const plan = await index.prepareMutationTimeSliced(removed, [], {
          shouldYield: () => false,
          yieldControl: async () => undefined,
        });
        if (plan === "cancelled") throw new Error("Expected a prepared boundary removal.");
        expect(index.size).toBe(6);
        expect(scan).toHaveBeenCalledTimes(work === 1_024 ? 0 : 1);
        plan.commit();
        expect(index.membershipCount).toBe(1_026 - work);
        expect(query(index, near)).toEqual(work === 1_024 ? [4] : []);
        expect(query(index, far)).toEqual([5]);
        expect(index.getMaximumBottom()).toBe(1_010);
      } finally {
        scan.mockRestore();
      }
    },
  );
});

describe("saturated spatial mutation validation", () => {
  it.each(["duplicate", "bounds", "membership", "overflow", "version"])(
    "rejects late %s failures after the shadow estimate is established",
    async (failure) => {
      const index = new UniformSpatialIndex<number>();
      index.insert(-1, far);
      const additions = invalidShadowInsertions(failure);
      if (failure === "version") {
        (index as unknown as { recordVersion: number }).recordVersion =
          Number.MAX_SAFE_INTEGER - additions.length + 1;
      }
      await expect(
        index.prepareMutationTimeSliced([], additions, {
          shouldYield: () => false,
          yieldControl: async () => undefined,
        }),
      ).rejects.toThrow();
      expect(index.size).toBe(1);
      expect(index.membershipCount).toBe(1);
      expect(index.overflowCount).toBe(0);
      expect(query(index, far)).toEqual([-1]);
      expect(index.getMaximumBottom()).toBe(1_010);
    },
  );
});

describe("saturated spatial mutation cancellation", () => {
  it.each(["cancelled", "stale"])(
    "stops %s staging after the shadow estimate is established",
    async (mode) => {
      const index = new UniformSpatialIndex<number>();
      index.insert(-1, far);
      const range = vi.spyOn(
        index as unknown as { prepareRange: (bounds: SpatialBounds) => unknown },
        "prepareRange",
      );
      let cancelled = false;
      try {
        const result = await index.prepareMutationTimeSliced(
          [],
          Array.from({ length: 1_200 }, (_, id) => ({ id, bounds: near })),
          {
            isCancelled: () => cancelled,
            shouldYield: () => range.mock.calls.length === 200,
            yieldControl: async () => {
              if (mode === "cancelled") cancelled = true;
              else index.insert(-2, near);
            },
          },
        );
        expect(result).toBe("cancelled");
        expect(range).toHaveBeenCalledTimes(mode === "cancelled" ? 200 : 201);
        expect(index.size).toBe(mode === "cancelled" ? 1 : 2);
        expect(query(index, far)).toEqual([-1]);
        expect(query(index, near)).toEqual(mode === "cancelled" ? [] : [-2]);
      } finally {
        range.mockRestore();
      }
    },
  );
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
    const index = createOverflowIndex();
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

function invalidShadowInsertions(failure: string) {
  if (failure === "membership") {
    return Array.from({ length: MAX_SPATIAL_MEMBERSHIPS / 256 + 1 }, (_, id) => ({
      id,
      bounds: maximumGrid,
    }));
  }
  if (failure === "overflow") {
    return Array.from({ length: MAX_OVERFLOW_ELEMENTS + 1 }, (_, id) => ({
      id,
      bounds: { ...near, maxX: 1_000_000 },
    }));
  }
  const prefix = Array.from({ length: 200 }, (_, id) => ({ id, bounds: near }));
  return [
    ...prefix,
    {
      id: failure === "duplicate" ? 0 : 200,
      bounds: failure === "bounds" ? { ...near, maxX: NaN } : near,
    },
  ];
}

function createOverflowIndex(maxY = near.maxY): UniformSpatialIndex<number> {
  const index = new UniformSpatialIndex<number>();
  const bounds = { ...near, maxX: 1_000_000, maxY };
  index.insertMany(Array.from({ length: MAX_OVERFLOW_ELEMENTS }, (_, id) => ({ id, bounds })));
  return index;
}

function query<Id>(index: UniformSpatialIndex<Id>, bounds: typeof near): Id[] {
  const scratch = new SpatialQueryScratch<Id>();
  index.query(bounds, scratch);
  return Array.from({ length: scratch.count }, (_, offset) => scratch.at(offset));
}
