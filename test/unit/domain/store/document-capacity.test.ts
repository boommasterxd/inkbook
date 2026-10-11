import { describe, expect, it } from "vitest";

import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/public";
import { DocumentCapacity } from "../../../../src/domain/store/document-capacity";
import type { ElementRecord } from "../../../../src/domain/store/types";

const BOUNDS = Object.freeze({ maxX: 1, maxY: 1, minX: 0, minY: 0 });

describe("DocumentCapacity exact aggregate limits", () => {
  it.each([
    {
      exact: Array.from({ length: FILE_SCHEMA_LIMITS.elements }, rectangleRecord),
      extra: rectangleRecord(),
      name: "elements",
    },
    {
      exact: Array.from({ length: FILE_SCHEMA_LIMITS.strokes }, () => strokeRecord(1)),
      extra: strokeRecord(1),
      name: "strokes",
    },
    {
      exact: [strokeRecord(FILE_SCHEMA_LIMITS.strokePoints)],
      extra: strokeRecord(1),
      name: "stroke points",
    },
    {
      exact: Array.from({ length: 40 }, (_, target) =>
        Array.from({ length: 500 }, () => linearRecord(`target-${target}`)),
      ).flat(),
      extra: linearRecord("target-extra"),
      name: "connected endpoints",
    },
    {
      exact: Array.from({ length: FILE_SCHEMA_LIMITS.connectedEndpointsPerTarget }, () =>
        linearRecord("target"),
      ),
      extra: linearRecord("target"),
      name: "per-target fanout",
    },
  ])("preserves exact $name state after rejecting one excess record", ({ exact, extra }) => {
    const capacity = new DocumentCapacity();
    capacity.commit(capacity.prepare([], exact));

    expect(() => capacity.prepare([], [extra])).toThrow(RangeError);

    capacity.commit(capacity.prepare([exact[0]!], []));
    expect(() => capacity.commit(capacity.prepare([], [extra]))).not.toThrow();
  });

  it("rejects a maximum bottom above the derived-height cap without consuming capacity", () => {
    const capacity = new DocumentCapacity();
    const exact = rectangleRecord(FILE_SCHEMA_LIMITS.maximumDerivedHeight ?? 1);
    capacity.commit(capacity.prepare([], [exact]));
    const excessive = rectangleRecord((FILE_SCHEMA_LIMITS.maximumDerivedHeight ?? 1) + 0.001);

    expect(() => capacity.prepare([], [excessive])).toThrow(RangeError);
    expect(() => capacity.commit(capacity.prepare([exact], [rectangleRecord(2)]))).not.toThrow();
  });
});

describe("DocumentCapacity scheduled patches", () => {
  it("consumes lazy record slots in removal-before-addition order at exact fanout capacity", async () => {
    const { capacity, previous } = fanoutReplacement();
    let removed = 0;
    function* removals() {
      yield null;
      for (const record of previous) {
        removed += 1;
        yield record;
      }
    }
    function* additions() {
      expect(removed).toBe(previous.length);
      yield null;
      yield* previous;
    }
    const prepared = await capacity.prepareTimeSliced(removals(), additions(), {
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    if (prepared === "cancelled") throw new Error("Expected a capacity patch.");
    capacity.commit(prepared.patch);
    expect(() => capacity.prepare([], [linearRecord("old-target")])).toThrow(RangeError);
    expect(() => capacity.commit(prepared.patch)).toThrow(/stale/);
  });

  it("cancels at a null projection slot before reading or validating following records", async () => {
    const capacity = new DocumentCapacity();
    let advanced = false;
    let cancelled = false;
    function* additions() {
      yield null;
      advanced = true;
      yield rectangleRecord((FILE_SCHEMA_LIMITS.maximumDerivedHeight ?? 1) + 1);
    }
    expect(
      await capacity.prepareTimeSliced([], additions(), {
        isCancelled: () => cancelled,
        shouldYield: () => true,
        yieldControl: async () => {
          cancelled = true;
        },
      }),
    ).toBe("cancelled");
    expect(advanced).toBe(false);
    expect(() => capacity.commit(capacity.prepare([], [rectangleRecord()]))).not.toThrow();
  });

  it("time-slices fanout patches and leaves cancelled preparation uncommitted", async () => {
    const { capacity, next, previous } = fanoutReplacement();
    let yields = 0;

    const cancelled = await capacity.prepareTimeSliced(previous, next, {
      isCancelled: () => yields === 2,
      shouldYield: () => yields < 2,
      yieldControl: async () => {
        yields += 1;
      },
    });

    expect(cancelled).toBe("cancelled");
    expect(() => capacity.prepare([], [linearRecord("old-target")])).toThrow(RangeError);
    expect(() => capacity.prepare([], [linearRecord("new-target")])).not.toThrow();
  });

  it("uses the remaining shared budget across large fanout patches", async () => {
    const { capacity, next, previous } = fanoutReplacement();
    let yields = 0;
    const prepared = await capacity.prepareTimeSliced(previous, next, {
      shouldYield: () => false,
      yieldControl: async () => {
        yields += 1;
      },
    });

    expect(prepared).not.toBe("cancelled");
    expect(yields).toBe(0);
    if (prepared === "cancelled") return;
    capacity.commit(prepared.patch);
    expect(() => capacity.prepare([], [linearRecord("old-target")])).not.toThrow();
    expect(() => capacity.prepare([], [linearRecord("new-target")])).toThrow(RangeError);
  });

  it("rejects a time-sliced patch made stale by another capacity commit", async () => {
    const capacity = new DocumentCapacity();
    const prepared = await capacity.prepareTimeSliced([], [rectangleRecord()], {
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    if (prepared === "cancelled") throw new Error("Expected a capacity patch.");

    capacity.commit(capacity.prepareUnchanged());

    expect(() => capacity.commit(prepared.patch)).toThrow(/stale/);
  });
});

function fanoutReplacement(): {
  readonly capacity: DocumentCapacity;
  readonly next: ElementRecord[];
  readonly previous: ElementRecord[];
} {
  const capacity = new DocumentCapacity();
  const previous = Array.from({ length: 512 }, () => linearRecord("old-target"));
  const next = Array.from({ length: 512 }, () => linearRecord("new-target"));
  capacity.commit(capacity.prepare([], previous));
  return { capacity, next, previous };
}

function rectangleRecord(maxY = 1): ElementRecord {
  return {
    bounds: { ...BOUNDS, maxY },
    element: { kind: "rectangle" } as unknown as ElementRecord["element"],
    geometryVersion: 0,
    paintVersion: 0,
  };
}

function strokeRecord(points: number): ElementRecord {
  return {
    bounds: BOUNDS,
    element: {
      kind: "stroke",
      points: { length: points * 3 },
    } as unknown as ElementRecord["element"],
    geometryVersion: 0,
    paintVersion: 0,
  };
}

function linearRecord(targetId: string): ElementRecord {
  return {
    bounds: BOUNDS,
    element: {
      endConnection: null,
      kind: "line",
      startConnection: { targetId },
    } as unknown as ElementRecord["element"],
    geometryVersion: 0,
    paintVersion: 0,
  };
}
