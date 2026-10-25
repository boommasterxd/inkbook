import {
  elementFactsSteps,
  validatedDeltaElementFactsSteps,
} from "../../../../src/persistence/serialization/output/incremental-validation";
import {
  completeSerializationSteps,
  consumeSerializationSteps,
} from "../../../../src/persistence/serialization/output/serialization-model-preparation";
import {
  prepareConnectionTargetCounts,
  updateConnectionTargetCounts,
} from "../../../../src/persistence/serialization/output/connection-target-counts";
import { expect, it, vi } from "vitest";

import { IncrementalDocumentSerializer } from "../../../../src/persistence/serialization/public";
import { prepareDocumentDeltaSteps } from "../../../../src/persistence/serialization/output/incremental-document-delta";
import { createSnapshot } from "../../../unit/persistence/serialization/fixtures";
import { StrokeShapeCache } from "../../../../src/persistence/serialization/output/stroke-shape-cache";
import { adoptTransferredStrokeSamples } from "../../../../src/persistence/worker/runtime/model/runtime-elements";
import { connectionChain } from "../../../fixtures/domain/connection-chain";
import {
  createPressureGroupFixture,
  createRetainedCapacityRectangle,
  createStandardPersistenceFixture,
} from "../fixtures";

function observeTargetIndexStaging(current: Map<string, number>) {
  const work = { copyReads: 0, sliceReads: 0, patchSets: 0, patchDeletes: 0, sliceWrites: 0 };
  const entries = current[Symbol.iterator].bind(current);
  let copying = false;
  let copied = false;
  let captured = false;
  let staged = new WeakSet<Map<string, number>>();
  current[Symbol.iterator] = function* () {
    copied = false;
    captured = false;
    staged = new WeakSet();
    for (const entry of entries()) {
      copying = true;
      work.copyReads += 1;
      work.sliceReads += 1;
      yield entry;
      copying = false;
    }
    copied = true;
  } as typeof entries;
  const originalSet = Reflect.get(Map.prototype, "set") as Map<string, number>["set"];
  const originalDelete = Reflect.get(Map.prototype, "delete") as Map<string, number>["delete"];
  const set = vi.spyOn(Map.prototype, "set").mockImplementation(function (
    this: Map<string, number>,
    id: string,
    count: number,
  ) {
    if (copying && !captured) {
      staged.add(this);
      captured = true;
    }
    if (staged.has(this) && copied) {
      work.patchSets += 1;
      work.sliceWrites += 1;
    }
    return originalSet.call(this, id, count);
  });
  const remove = vi.spyOn(Map.prototype, "delete").mockImplementation(function (
    this: Map<string, number>,
    id: string,
  ) {
    if (staged.has(this) && copied) {
      work.patchDeletes += 1;
      work.sliceWrites += 1;
    }
    return originalDelete.call(this, id);
  });
  return {
    work,
    checkpoint: () => {
      expect(work.sliceReads).toBeLessThanOrEqual(256);
      expect(work.sliceWrites).toBeLessThanOrEqual(256);
      work.sliceReads = 0;
      work.sliceWrites = 0;
      return undefined;
    },
    restore: () => {
      set.mockRestore();
      remove.mockRestore();
      current[Symbol.iterator] = entries;
    },
  };
}

it("stages a maximum coalesced connection replacement through bounded checkpoints", async () => {
  const elements = connectionChain(10_000);
  const byId = new Map(elements.map((element) => [element.id, element]));
  const current = new Map<string, number>();
  for (const element of elements) updateConnectionTargetCounts(current, element, 1);
  const remap = (id: string) => `10000000${id.slice(8)}`;
  const replacements = elements.map((element) => ({
    ...element,
    id: remap(element.id),
    startConnection:
      element.startConnection === null
        ? null
        : {
            ...element.startConnection,
            targetId: remap(element.startConnection.targetId),
          },
  }));
  const changed = new Map(replacements.map((element) => [element.id, element]));
  const removed = new Set(byId.keys());
  const observed = observeTargetIndexStaging(current);
  try {
    const next = await consumeSerializationSteps(
      prepareConnectionTargetCounts(current, byId, changed, removed, 256),
      { signal: new AbortController().signal, checkpoint: observed.checkpoint },
    );
    observed.checkpoint();
    expect(observed.work).toMatchObject({
      copyReads: 9_999,
      patchSets: 9_999,
      patchDeletes: 9_999,
    });
    expect(current.size).toBe(9_999);
    expect(next.size).toBe(9_999);
    expect(next === current).toBe(false);
    Object.assign(observed.work, { copyReads: 0, patchSets: 0, patchDeletes: 0 });
    const controller = new AbortController();
    await expect(
      consumeSerializationSteps(
        prepareConnectionTargetCounts(current, byId, changed, removed, 256),
        {
          signal: controller.signal,
          checkpoint: () => {
            observed.checkpoint();
            if (observed.work.patchSets + observed.work.patchDeletes > 0) controller.abort();
            return undefined;
          },
        },
      ),
    ).rejects.toThrow();
    expect(observed.work.copyReads).toBe(9_999);
    expect(observed.work.patchSets + observed.work.patchDeletes).toBeGreaterThan(0);
    expect(observed.work.patchSets + observed.work.patchDeletes).toBeLessThanOrEqual(256);
    expect(current.size).toBe(9_999);
    expect(current.get(elements[0]!.id)).toBe(1);
  } finally {
    observed.restore();
  }
});

it("does not visit unrelated model records to discover connections for an unconnected shape", () => {
  const fixture = createStandardPersistenceFixture();
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.resetRuntime(fixture).ok).toBe(true);
  const connectionTargetEntries = serializer.instrumentation.connectionTargetEntries;
  const retained = serializer.currentSnapshot()!.elements;
  let recordReads = 0;
  for (const element of retained) {
    const kind = element.kind;
    Object.defineProperty(element, "kind", {
      enumerable: true,
      get() {
        recordReads += 1;
        return kind;
      },
    });
  }
  const inserted = createRetainedCapacityRectangle(900_000);
  expect(
    serializer.applyDelta({
      baseModelRevision: fixture.revision,
      modelRevision: fixture.revision + 1,
      changedElements: [inserted],
      orderChanges: {
        content: [
          ...fixture.elements
            .filter((element) => element.kind !== "stroke" || element.tool !== "highlighter")
            .map(({ id }) => id),
          inserted.id,
        ],
      },
    }).ok,
  ).toBe(true);
  // Structural order validation still visits existing records; relation discovery must not add a scan.
  expect(recordReads).toBeLessThanOrEqual(2 * retained.length);
  recordReads = 0;
  expect(
    serializer.applyDelta({
      baseModelRevision: fixture.revision + 1,
      modelRevision: fixture.revision + 2,
      changedElements: [{ ...inserted, style: { ...inserted.style, fillOpacity: 0.25 } }],
    }).ok,
  ).toBe(true);
  expect(recordReads).toBe(0);
  expect(serializer.instrumentation.connectionTargetEntries).toBe(connectionTargetEntries);
  serializer.clear();
});

it("reuses validated order without scanning 10k elements for a small edit", () => {
  const elements = Array.from({ length: 10_000 }, (_, index) =>
    createRetainedCapacityRectangle(index + 1),
  );
  const content = elements.map(({ id }) => id);
  const currentElements = new Map(elements.map((element) => [element.id, element] as const));
  const originalIterator = currentElements[Symbol.iterator].bind(currentElements);
  let fullMapIterations = 0;
  currentElements[Symbol.iterator] = () => {
    fullMapIterations += 1;
    return originalIterator();
  };
  const options = {
    currentElements,
    currentOrders: { content, highlight: [] },
    currentPage: createSnapshot().page,
  };
  const changed = { ...elements[0]!, createdAt: 100 };
  const prepared = completeSerializationSteps(
    prepareDocumentDeltaSteps({
      ...options,
      delta: { changedElements: [changed], baseModelRevision: 7, modelRevision: 8 },
    }),
  );
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error(prepared.error.message);
  expect(prepared.value.orders.content).toBe(content);
  expect(fullMapIterations).toBe(0);

  const invalidOrder = completeSerializationSteps(
    prepareDocumentDeltaSteps({
      ...options,
      delta: {
        baseModelRevision: 7,
        modelRevision: 8,
        orderChanges: { content: [content[0]!, content[0]!] },
      },
    }),
  );
  expect(invalidOrder).toMatchObject({ ok: false, error: { code: "invalid-order" } });
  // The supplied band is still rejected completely without copying the document map.
  expect(fullMapIterations).toBe(0);
});

it.each([1_000, 20_000])(
  "reads changed geometry only when updating capacity among %i elements",
  (size) => {
    const elements = Array.from({ length: size }, (_, index) =>
      createRetainedCapacityRectangle(index + 1),
    );
    const serializer = new IncrementalDocumentSerializer();
    expect(serializer.reset(createSnapshot(elements)).ok).toBe(true);
    const retained = serializer.currentSnapshot()!.elements;
    let unchangedReads = 0;
    let changedReads = 0;
    for (const element of retained) {
      if (element.kind !== "rectangle") throw new Error("Expected retained rectangles.");
      const width = element.width;
      Object.defineProperty(element, "width", {
        enumerable: true,
        get() {
          unchangedReads += 1;
          return width;
        },
      });
    }
    for (let revision = 8; revision < 11; revision += 1) {
      const changed = new Proxy(
        { ...elements[0]!, x: 100 + (revision % 2), pivot: { x: 150 + (revision % 2), y: 150 } },
        {
          get(target, key, receiver) {
            if (key === "width") changedReads += 1;
            return Reflect.get(target, key, receiver) as unknown;
          },
        },
      );
      expect(
        serializer.applyDelta({
          baseModelRevision: revision - 1,
          changedElements: [changed],
          modelRevision: revision,
        }),
      ).toEqual({ ok: true, value: undefined });
    }

    expect(unchangedReads).toBe(0);
    expect(changedReads).toBeGreaterThan(0);
    expect(changedReads).toBeLessThanOrEqual(3 * 32);
    expect(serializer.instrumentation).toMatchObject({
      fullValidationRuns: 1,
      incrementalValidationRuns: 3,
      fragmentBuilds: 0,
      cacheElements: 0,
    });
    expect(serializer.prewarmElement(elements[0]!.id, 1024 * 1024)).not.toBeNull();
    expect(serializer.instrumentation).toMatchObject({
      fragmentBuilds: 1,
      cacheElements: 1,
    });
    serializer.clear();
  },
);

it("retains local pressure contours across complete 10k-stroke placement sweeps", () => {
  const fixture = createPressureGroupFixture();
  const cache = new StrokeShapeCache();
  const strokes = fixture.elements;
  for (const stroke of strokes) cache.resolve(stroke);
  expect(cache.instrumentation.shapeBuilds).toBe(10_000);
  expect(cache.instrumentation.shapeCacheElements).toBe(10_000);
  for (const offset of [
    { x: 5, y: 10 },
    { x: 0, y: 0 },
    { x: 5, y: 10 },
  ]) {
    for (const stroke of strokes) {
      cache.resolve({
        ...stroke,
        offset,
        pivot: { x: stroke.pivot.x + offset.x, y: stroke.pivot.y + offset.y },
      });
    }
  }
  expect(cache.instrumentation.shapeBuilds).toBe(10_000);
  for (const stroke of strokes) cache.retire(stroke.id);
  const restored = strokes.map((stroke) => ({
    ...stroke,
    points: adoptTransferredStrokeSamples(new Float64Array(stroke.points)),
  }));
  for (const stroke of restored) cache.resolve(stroke);
  expect(cache.instrumentation.shapeBuilds).toBe(10_000);
  const compared = restored.reduce((total, stroke) => total + stroke.points.length, 0);
  expect(cache.instrumentation.retiredPointComparisons).toBe(compared);
  for (const stroke of restored) cache.resolve(stroke);
  expect(cache.instrumentation.retiredPointComparisons).toBe(compared);
  expect(cache.instrumentation.shapeCacheBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  cache.clear();
  expect(cache.instrumentation).toEqual({
    shapeBuilds: 0,
    shapeCacheBytes: 0,
    shapeCacheElements: 0,
    retiredPointComparisons: 0,
  });
});

it("does not reread pressure samples when deriving unchanged local geometry bounds for moves", () => {
  const fixture = createPressureGroupFixture();
  let sampleReads = 0;
  const strokes = fixture.elements.map((stroke) => ({
    ...stroke,
    points: new Proxy(stroke.points, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/u.test(key)) sampleReads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    }),
  }));
  const facts = strokes.map((stroke) => completeSerializationSteps(elementFactsSteps(stroke)));
  expect(sampleReads).toBeGreaterThan(500_000);
  sampleReads = 0;
  for (const [index, stroke] of strokes.entries()) {
    const offset = { x: 0.125, y: 12.375 };
    const moved = {
      ...stroke,
      offset,
      pivot: { x: stroke.pivot.x + offset.x, y: stroke.pivot.y + offset.y },
    };
    const changed = completeSerializationSteps(
      validatedDeltaElementFactsSteps(moved, undefined, facts[index]),
    );
    expect(changed.strokeGeometry?.bounds).toBe(facts[index]!.strokeGeometry?.bounds);
  }
  expect(sampleReads).toBe(0);
});
