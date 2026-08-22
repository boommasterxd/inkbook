import { describe, expect, it, vi } from "vitest";

import { getCanonicalStrokeReplacementProof } from "../../../../src/domain/elements/stroke-replacement-proof";
import { correctElementsToPageBounds } from "../../../../src/domain/geometry/public";
import type { InkElementV1, StrokeElementV1 } from "../../../../src/domain/schema/public";
import { MAX_SPATIAL_MEMBERSHIPS, SpatialQueryScratch } from "../../../../src/domain/spatial/index";
import { ElementStore, type ImmutableInkElement } from "../../../../src/domain/store/public";
import { moveSelectionTimeSliced } from "../../../../src/editor/selection/public";

import { connectedLine, highlighter, IDS, mixedElement, PAGE, rectangle } from "./fixtures";

describe("ElementStore normalized ownership", () => {
  it("builds fixed bands, ranks, immutable records, and the spatial index", () => {
    const target = rectangle();
    const store = new ElementStore([target, highlighter(), connectedLine(target)]);
    const record = store.get(IDS.target)!;
    const scratch = new SpatialQueryScratch<string>();

    expect(store.materializeBandOrder("highlight")).toEqual([IDS.highlight]);
    expect(store.materializeBandOrder("content")).toEqual([IDS.target, IDS.line]);
    expect(store.getRank(IDS.line)).toEqual({ band: "content", rank: 1 });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.element)).toBe(true);
    expect(Object.isFrozen(record.element.pivot)).toBe(true);
    expect(store.query(record.bounds, scratch)).toBeGreaterThanOrEqual(1);
  });

  it("creates atomically with one delta and retains existing record identity", () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    const targetRecord = store.get(target.id)!;
    const listener = vi.fn();
    store.subscribe(listener);
    store.resetInstrumentation();

    const delta = store.create([highlighter(), connectedLine(target)]);

    expect(delta?.changes).toHaveLength(2);
    expect(delta?.changes[0]?.domains).toEqual(["geometry", "paint", "order", "visibility"]);
    expect(delta?.changes[1]?.domains).toEqual([
      "geometry",
      "paint",
      "order",
      "connection",
      "visibility",
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get(target.id)).toBe(targetRecord);
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      publishedDeltas: 1,
      recordReplacements: 0,
      snapshotMaterializations: 0,
    });
  });

  it("keeps geometry versions, bounds, and spatial membership stable for paint-only changes", () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    const before = store.get(target.id)!;
    const replacement = rectangle();
    replacement.style = {
      ...replacement.style,
      fillColor: { type: "rgba", value: "#AABBCCFF" },
      fillOpacity: 0.5,
    };

    const delta = store.replace(target.id, replacement);
    const after = store.get(target.id)!;

    expect(delta?.changes.map(({ domains }) => domains)).toEqual([["paint"]]);
    expect(after.geometryVersion).toBe(before.geometryVersion);
    expect(after.paintVersion).toBeGreaterThan(before.paintVersion);
    expect(after.bounds).toBe(before.bounds);
  });

  it("materializes a detached wire snapshot only on explicit request", () => {
    const target = rectangle();
    const store = new ElementStore([target, highlighter()]);
    store.resetInstrumentation();

    const snapshot = store.materializeSnapshot({ page: PAGE, revision: 7 });
    snapshot.elements[0]!.pivot.x = 999;

    expect(snapshot.revision).toBe(7);
    expect(snapshot.elements.map(({ id }) => id)).toEqual([IDS.highlight, IDS.target]);
    expect(store.get(IDS.highlight)!.element.pivot.x).toBe(150);
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 1,
      snapshotMaterializations: 1,
    });
  });
});

describe("ElementStore canonical prepared replacement", () => {
  it("commits a proven canonical stroke translation with exact geometry-only state", async () => {
    const { current, store } = preparedStrokeStore();
    const before = store.get(current.id)!;
    const replacements = await moveSelectionTimeSliced(
      [current as StrokeElementV1],
      { x: 1, y: 2 },
      {
        shouldYield: () => false,
        yieldControl: async () => undefined,
      },
    );
    if (replacements === null) throw new Error("Expected a canonical stroke replacement.");

    const prepared = await store.prepareElementReplacement(replacements, {
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    if (prepared.token === null) throw new Error("Expected a prepared replacement token.");
    const result = store.commitPreparedElementReplacement(prepared.token);
    const after = store.get(current.id)!;

    expect(result.delta?.changes).toMatchObject([{ domains: ["geometry"], id: current.id }]);
    expect(after.geometryVersion).toBe(before.geometryVersion + 1);
    expect(after.paintVersion).toBe(before.paintVersion);
    expect(after.bounds).toEqual({
      maxX: before.bounds.maxX + 1,
      maxY: before.bounds.maxY + 2,
      minX: before.bounds.minX + 1,
      minY: before.bounds.minY + 2,
    });
  });
});

describe("ElementStore prepared replacement", () => {
  it("publishes a time-sliced stroke replacement only after its atomic index swap", async () => {
    const source = highlighter();
    const store = new ElementStore([source]);
    const before = store.get(source.id)!;
    if (before.element.kind !== "stroke") throw new Error("Expected stroke record.");
    const replacement = translatedStroke(before.element);
    let observedPartialState = false;
    let yields = 0;

    const prepared = await store.prepareElementReplacement([replacement], {
      shouldYield: () => true,
      yieldControl: async () => {
        yields += 1;
        if (store.get(source.id) !== before) observedPartialState = true;
      },
    });
    if (prepared.token === null) throw new Error("Expected prepared replacement token.");
    expect(store.get(source.id)).toBe(before);
    const result = store.commitPreparedElementReplacement(prepared.token);

    expect(result.status).toBe("committed");
    expect(result.delta?.changes).toHaveLength(1);
    expect(observedPartialState).toBe(false);
    expect(store.get(source.id)).not.toBe(before);
    expect(getCanonicalStrokeReplacementProof(store.get(source.id)!.element)).toBeUndefined();
    expect(yields).toBeGreaterThan(0);
    expect(store.instrumentation).toMatchObject({
      timeSlicedIndexVisits: 1,
      timeSlicedReplacementYields: yields,
    });
    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("cancelled");
  });

  it("returns no-op and rejects a token made stale by a newer commit", async () => {
    const source = highlighter();
    const target = rectangle();
    const store = new ElementStore([source, target]);
    const current = store.get(source.id)?.element;
    if (current?.kind !== "stroke") throw new Error("Expected stroke record.");
    const scheduler = {
      shouldYield: () => false,
      yieldControl: async () => undefined,
    };
    const noOp = await store.prepareElementReplacement(
      [current as unknown as StrokeElementV1],
      scheduler,
    );
    expect(noOp).toEqual({ status: "noop", token: null });

    const replacement = translatedStroke(current);
    const prepared = await store.prepareElementReplacement([replacement], scheduler);
    if (prepared.token === null) throw new Error("Expected prepared replacement token.");
    const paintChange = rectangle();
    paintChange.style = { ...paintChange.style, fillOpacity: 0.5 };
    store.replace(target.id, paintChange);

    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("cancelled");
    expect(store.get(source.id)?.element).toBe(current);
  });

  it("time-slices a large mixed replacement and publishes no partial state", async () => {
    const elements = Array.from({ length: 1_024 }, (_, index) => mixedElement(index));
    const store = new ElementStore(elements);
    const firstRecord = store.get(elements[0]!.id);
    const replacements = elements.map(translatedMixedElement);
    let checks = 0;
    let yields = 0;
    const prepared = await store.prepareElementReplacement(replacements, {
      shouldYield: () => ++checks % 32 === 0,
      yieldControl: async () => {
        yields += 1;
        expect(store.get(elements[0]!.id)).toBe(firstRecord);
      },
    });
    if (prepared.token === null) throw new Error("Expected prepared replacement token.");

    expect(yields).toBeGreaterThan(1);
    expect(store.commitPreparedElementReplacement(prepared.token)).toMatchObject({
      status: "committed",
    });
    expect(store.get(elements[0]!.id)?.element.pivot.x).toBe(elements[0]!.pivot.x + 1);
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      publishedDeltas: 1,
      timeSlicedIndexVisits: 1_024,
    });
  });
});

describe("ElementStore prepared replacement rejection", () => {
  it("cleans up cancelled preparation without publishing", async () => {
    const { current, source, store } = preparedStrokeStore();
    const replacement = translatedStroke(current);

    const prepared = await store.prepareElementReplacement([replacement], {
      isCancelled: () => true,
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });

    expect(prepared).toEqual({ status: "cancelled", token: null });
    expect(store.get(source.id)?.element).toBe(current);
    expect(store.instrumentation.publishedDeltas).toBe(0);
  });

  it("fully validates replacements without an internal canonical proof", async () => {
    const { current, store } = preparedStrokeStore();
    const invalid: StrokeElementV1 = {
      ...current,
      points: [Number.NaN, 300, 0.5, 200, 300, 0.5],
    };

    await expect(
      store.prepareElementReplacement([invalid], {
        shouldYield: () => false,
        yieldControl: async () => undefined,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("ElementStore transaction validation", () => {
  it("requires replacement callers to apply the shared page-bound correction", () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    const moved = rectangle(target.id, -100, -50);

    expect(() => store.replace(target.id, moved)).toThrow(
      "Conservative element bounds must remain within the supported page",
    );
    const correction = correctElementsToPageBounds([moved]);
    expect(correction.status).toBe("accepted");
    if (correction.status !== "accepted") return;
    expect(store.replace(target.id, correction.elements[0]!)).not.toBeNull();
    expect(store.get(target.id)?.bounds).toMatchObject({ minX: 0, minY: 0 });
  });

  it("corrects created geometry at the horizontal and top page edges before commit", () => {
    const candidate = rectangle(IDS.other, -100, -50);
    const store = new ElementStore();

    const delta = store.create(candidate);

    expect(delta?.changes).toHaveLength(1);
    expect(store.get(candidate.id)?.bounds).toMatchObject({ minX: 0, minY: 0 });
    expect(store.get(candidate.id)?.element.pivot).toEqual({ x: 102, y: 52 });
  });

  it("rejects created geometry whose conservative width cannot fit the page", () => {
    const candidate = { ...rectangle(), pivot: { x: 1_024, y: 150 }, width: 2_048, x: 0 };
    const store = new ElementStore();

    expect(() => store.create(candidate)).toThrow("exceeds the supported page width");
    expect(store.size).toBe(0);
  });

  it("rejects duplicate and invalid creations without publishing partial state", () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    const listener = vi.fn();
    store.subscribe(listener);
    const invalid = connectedLine(target);
    invalid.startConnection = {
      anchor: { kind: "box", position: "top-left" },
      targetId: IDS.other,
    };

    expect(() => store.create([highlighter(), invalid])).toThrow(RangeError);
    expect(store.size).toBe(1);
    expect(store.get(IDS.highlight)).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    expect(() => store.create(target)).toThrow(RangeError);
  });

  it("keeps an exact fanout-cap store coherent when an atomic create is rejected", () => {
    const target = rectangle();
    const lines = Array.from({ length: 512 }, (_, index) => ({
      ...connectedLine(target),
      createdAt: index + 2,
      id: `00000000-0000-4000-8002-${index.toString().padStart(12, "0")}`,
    }));
    const store = new ElementStore([target, ...lines]);
    const targetRecord = store.get(target.id);
    const listener = vi.fn();
    store.subscribe(listener);
    const extra = {
      ...connectedLine(target),
      id: "00000000-0000-4000-8002-999999999999",
    };

    expect(() => store.create(extra)).toThrow(RangeError);
    expect(store.size).toBe(513);
    expect(store.get(target.id)).toBe(targetRecord);
    expect(dependentCount(store, target.id)).toBe(512);
    expect(listener).not.toHaveBeenCalled();

    store.remove([lines[0]!.id]);
    expect(() => store.create(extra)).not.toThrow();
    expect(dependentCount(store, target.id)).toBe(512);
  });

  it("does not replace a record or publish a delta for a semantic no-op", () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    const before = store.get(target.id)!;

    expect(store.replace(target.id, rectangle())).toBeNull();
    expect(store.get(target.id)).toBe(before);
    expect(store.instrumentation.recordReplacements).toBe(0);
  });

  it("validates replacement identity and style schema", () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    const changedIdentity: InkElementV1 = { ...target, createdAt: 99 };

    expect(() => store.replace(target.id, changedIdentity)).toThrow(RangeError);
    expect(() => store.updateStyle(target.id, highlighter().style)).toThrow(RangeError);
    expect(store.get(target.id)!.element).toEqual(target);
  });
});

describe("ElementStore time-sliced hydration", () => {
  it("resolves cross-order connections only after the complete index exists", async () => {
    const target = rectangle();
    let yields = 0;
    const store = await ElementStore.createTimeSliced([connectedLine(target), target], {
      shouldYield: () => true,
      yieldControl: async () => {
        yields += 1;
      },
    });

    expectHydratedConnection(store, target, yields);
  });

  it("releases cancelled hydration without returning a partial store", async () => {
    const store = await ElementStore.createTimeSliced([highlighter(), rectangle()], {
      isCancelled: () => true,
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });

    expect(store).toBeNull();
  });

  it("adopts bounded batches and resolves connections only during finalization", async () => {
    const target = rectangle();
    const builder = ElementStore.createBuilder({
      shouldYield: () => true,
      yieldControl: async () => undefined,
    });

    expect(await builder.append([connectedLine(target)])).toBe("accepted");
    expect(await builder.append([target])).toBe("accepted");
    const store = await builder.finalize();
    builder.cancel();

    expectHydratedConnection(store, target, 4);
  });

  it("releases accumulated batches after cancellation", async () => {
    let cancelled = false;
    const builder = ElementStore.createBuilder({
      isCancelled: () => cancelled,
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    expect(await builder.append([highlighter()])).toBe("accepted");

    cancelled = true;
    expect(await builder.append([rectangle()])).toBe("cancelled");
    expect(await builder.finalize()).toBeNull();
  });

  it("rejects unresolved cross-batch connections without publishing a store", async () => {
    const target = rectangle();
    const builder = ElementStore.createBuilder({
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    await builder.append([connectedLine(target)]);

    await expect(builder.finalize()).rejects.toThrow(RangeError);
    expect(await builder.finalize()).toBeNull();
  });

  it("rejects aggregate spatial membership during incremental store construction", async () => {
    const builder = ElementStore.createBuilder({
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    const entries = Array.from({ length: MAX_SPATIAL_MEMBERSHIPS / 256 }, (_, index) =>
      wideGridRectangle(index),
    );

    expect(await builder.append(entries)).toBe("accepted");
    await expect(builder.append([mixedElement(entries.length)])).rejects.toThrow(RangeError);
    expect(await builder.finalize()).toBeNull();
  });
});

function wideGridRectangle(index: number): InkElementV1 {
  const base = rectangle(`00000000-0000-4000-8001-${index.toString().padStart(12, "0")}`, 4, 4);
  return {
    ...base,
    pivot: { x: 32_764, y: 54 },
    width: 65_520,
  };
}

function translatedMixedElement(element: InkElementV1): InkElementV1 {
  if (element.kind === "stroke") {
    return {
      ...element,
      pivot: { x: element.pivot.x + 1, y: element.pivot.y + 1 },
      points: element.points.map((value, index) => (index % 3 === 2 ? value : value + 1)),
    };
  }
  if (element.kind !== "rectangle") throw new Error("Unexpected mixed fixture kind.");
  return {
    ...element,
    pivot: { x: element.pivot.x + 1, y: element.pivot.y + 1 },
    x: element.x + 1,
    y: element.y + 1,
  };
}

function translatedStroke(
  current: Extract<ImmutableInkElement, { readonly kind: "stroke" }>,
): StrokeElementV1 {
  return {
    ...current,
    pivot: { x: 151, y: 301 },
    points: [101, 301, 0.5, 201, 301, 0.5],
  };
}

function preparedStrokeStore(): {
  readonly current: Extract<ImmutableInkElement, { readonly kind: "stroke" }>;
  readonly source: StrokeElementV1;
  readonly store: ElementStore;
} {
  const source = highlighter();
  const store = new ElementStore([source]);
  const current = store.get(source.id)?.element;
  if (current?.kind !== "stroke") throw new Error("Expected stroke record.");
  return { current, source, store };
}

function expectHydratedConnection(
  store: ElementStore | null,
  target: ReturnType<typeof rectangle>,
  hydrationYields: number,
): void {
  expect(store?.size).toBe(2);
  expect(store?.get(IDS.line)?.element).toEqual(connectedLine(target));
  expect(store?.instrumentation).toMatchObject({
    hydrationElementVisits: 4,
    hydrationYields,
    publishedDeltas: 0,
  });
}

function dependentCount(store: ElementStore, targetId: string): number {
  let count = 0;
  store.visitDependents(targetId, () => {
    count += 1;
  });
  return count;
}
