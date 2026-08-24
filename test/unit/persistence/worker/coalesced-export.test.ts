import { describe, expect, it } from "vitest";

import { CoalescedExportTarget } from "../../../../src/persistence/worker/coalesced-export";

interface ElementRecord {
  readonly id: string;
  readonly value: number;
}

describe("coalesced export target", () => {
  it("keeps latest element and page values while removals win within a delta", () => {
    const target = new CoalescedExportTarget<ElementRecord, { height: number }>(4, ({ id }) => id);
    target.record({
      changedElements: [
        { id: "a", value: 1 },
        { id: "b", value: 1 },
      ],
      dirtyBands: ["content"],
      modelRevision: 5,
      page: { height: 100 },
    });
    target.record({
      changedElements: [
        { id: "a", value: 2 },
        { id: "c", value: 1 },
      ],
      modelRevision: 6,
      page: { height: 200 },
      removedIds: ["b", "c"],
    });

    expect(target.materialize({ orderByBand: { content: ["a"] } })).toEqual({
      baseModelRevision: 4,
      changedElements: [{ id: "a", value: 2 }],
      modelRevision: 6,
      orderChanges: { content: ["a"] },
      page: { height: 200 },
      removedIds: ["b", "c"],
      type: "incremental",
    });
  });

  it("materializes complete order only when the dirty band dispatches", () => {
    const target = new CoalescedExportTarget<ElementRecord, never>(0, ({ id }) => id);
    target.record({ dirtyBands: ["highlight", "highlight"], modelRevision: 1 });
    expect(() => target.materialize({})).toThrow("complete order");
    expect(target.materialize({ orderByBand: { highlight: ["h2", "h1"] } })).toMatchObject({
      orderChanges: { highlight: ["h2", "h1"] },
    });
  });

  it("upgrades one pending entry to a full snapshot after baseline invalidation", () => {
    const target = new CoalescedExportTarget<ElementRecord, never>(1, ({ id }) => id);
    target.record({ changedElements: [{ id: "a", value: 1 }], modelRevision: 2 });
    target.requireFullSnapshot(2);
    target.record({ changedElements: [{ id: "b", value: 1 }], modelRevision: 3 });

    expect(target.requiresFullSnapshot).toBe(true);
    expect(() => target.materialize({})).toThrow("complete snapshot");
    expect(target.materialize({ snapshot: { revision: 3 } })).toEqual({
      baseModelRevision: null,
      modelRevision: 3,
      snapshot: { revision: 3 },
      type: "full",
    });
  });

  it("rejects revision regression", () => {
    const target = new CoalescedExportTarget<ElementRecord, never>(5, ({ id }) => id);
    expect(() => target.record({ modelRevision: 4 })).toThrow(RangeError);
    expect(() => target.requireFullSnapshot(4)).toThrow(RangeError);
  });

  it("keeps only derivations that match the latest coalesced element revision", () => {
    const target = new CoalescedExportTarget<ElementRecord, never>(0, ({ id }) => id);
    const derivation = {
      bounds: { maxX: 2, maxY: 2, minX: 1, minY: 1 },
      elementId: "a",
      spatialMemberships: 1,
      spatialOverflow: false,
    };
    target.record({
      changedElementDerivations: [derivation],
      changedElements: [{ id: "a", value: 1 }],
      modelRevision: 1,
    });
    expect(target.materialize({})).toMatchObject({ changedElementDerivations: [derivation] });

    target.record({ changedElements: [{ id: "a", value: 2 }], modelRevision: 2 });
    expect(target.materialize({})).not.toHaveProperty("changedElementDerivations");
    expect(() =>
      target.record({ changedElementDerivations: [derivation], modelRevision: 3 }),
    ).toThrow("match changed elements");
  });
});
