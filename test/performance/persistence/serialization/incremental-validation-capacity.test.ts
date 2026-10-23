import {
  elementFactsSteps,
  validatedDeltaElementFactsSteps,
} from "../../../../src/persistence/serialization/output/incremental-validation";
import { completeSerializationSteps } from "../../../../src/persistence/serialization/output/serialization-model-preparation";
import { expect, it } from "vitest";

import { IncrementalDocumentSerializer } from "../../../../src/persistence/serialization/public";
import { prepareDocumentDeltaSteps } from "../../../../src/persistence/serialization/output/incremental-document-delta";
import { createSnapshot } from "../../../unit/persistence/serialization/fixtures";
import { StrokeShapeCache } from "../../../../src/persistence/serialization/output/stroke-shape-cache";
import { adoptTransferredStrokeSamples } from "../../../../src/persistence/worker/runtime/model/runtime-elements";
import { createPressureGroupFixture, createRetainedCapacityRectangle } from "../fixtures";

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
