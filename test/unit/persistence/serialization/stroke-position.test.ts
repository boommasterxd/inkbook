import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import {
  elementFacts,
  validatedDeltaElementFacts,
} from "../../../../src/persistence/serialization/incremental-validation";
import { StrokeShapeCache } from "../../../../src/persistence/serialization/stroke-shape-cache";
import {
  adoptTransferredStrokeSamples,
  copySnapshotToRuntime,
} from "../../../../src/persistence/worker/runtime/runtime-elements";
import { IncrementalDocumentSerializer } from "../../../../src/persistence/serialization/incremental-document-serializer";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { describe, expect, it } from "vitest";
import { validateSafeSvg } from "../../../../src/persistence/documents/safe-svg-validator";
import { canonicalElement } from "../../../../src/persistence/serialization/canonical-snapshot";
import { serializeElementPaths } from "../../../../src/persistence/serialization/path-markup";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { createAllElementSnapshot, createSnapshot } from "./fixtures";

function stroke() {
  const value = createAllElementSnapshot().elements.find((element) => element.kind === "stroke");
  if (value === undefined) throw new Error("Missing stroke fixture");
  return value;
}

describe("durable stroke placement", () => {
  it.each([false, true])(
    "round trips local samples and safe translated markup with pressure=%s",
    async (pressureEnabled) => {
      const original = stroke();
      const placed = {
        ...original,
        offset: { x: 12.5, y: 25 },
        pivot: { x: original.pivot.x + 12.5, y: original.pivot.y + 25 },
        style: { ...original.style, pressureEnabled },
      };
      expect(canonicalElement(original)).not.toHaveProperty("offset");
      expect(canonicalElement(placed)).toHaveProperty("offset", placed.offset);
      const localMarkup = serializeElementPaths({ ...original, style: placed.style }).join("");
      const markup = serializeElementPaths(placed).join("");
      expect(markup.match(/d="([^"]+)"/u)?.[1]).toBe(localMarkup.match(/d="([^"]+)"/u)?.[1]);
      expect(markup).toContain('transform="translate(12.5 25)"');
      const saved = serializeInkbookDocument(createSnapshot([placed]));
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(validateSafeSvg(saved.value.svg)).not.toBeNull();
      const parsed = await parseInkbookDocumentForTest(saved.value.svg);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.snapshot.elements[0]).toEqual(canonicalElement(placed));
    },
  );
});

it("reuses worker-runtime geometry while exporting moved, undone, and redone strokes", () => {
  const original = stroke();
  const runtime = copySnapshotToRuntime(
    createSnapshot([{ ...original, style: { ...original.style, pressureEnabled: true } }]),
  );
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.resetRuntime(runtime, true).ok).toBe(true);
  expect(serializer.serialize().ok).toBe(true);
  const retained = serializer.currentSnapshot()!.elements[0]!;
  if (retained.kind !== "stroke") throw new Error("Missing retained stroke");
  for (let revision = 8; revision <= 10; revision += 1) {
    const offset = revision === 9 ? { x: 0, y: 0 } : { x: 12, y: 25 };
    const moved = {
      ...retained,
      offset,
      pivot: { x: retained.pivot.x + offset.x, y: retained.pivot.y + offset.y },
    };
    expect(
      serializer.applyDelta(
        {
          baseModelRevision: revision - 1,
          modelRevision: revision,
          changedElements: [moved],
        },
        undefined,
        true,
      ).ok,
    ).toBe(true);
    expect(serializer.serialize().ok).toBe(true);
  }
  expect(serializer.instrumentation.shapeBuilds).toBe(1);
});

it("keeps compatible local shapes across full resets and invalidates changed samples", () => {
  const runtime = copySnapshotToRuntime(createSnapshot([stroke()]));
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.resetRuntime(runtime, true).ok).toBe(true);
  expect(serializer.serialize().ok).toBe(true);
  expect(serializer.instrumentation.shapeBuilds).toBe(1);

  const original = runtime.elements[0]!;
  if (original.kind !== "stroke") throw new Error("Missing runtime stroke");
  const repainted = { ...original, style: { ...original.style, opacity: 0.5 } };
  expect(serializer.resetRuntime({ ...runtime, elements: [repainted], revision: 8 }, true).ok).toBe(
    true,
  );
  expect(serializer.serialize().ok).toBe(true);
  expect(serializer.instrumentation.shapeBuilds).toBe(1);

  const reshaped = { ...repainted, points: [...repainted.points] };
  reshaped.points[0] = reshaped.points[0]! + 1;
  expect(serializer.resetRuntime({ ...runtime, elements: [reshaped], revision: 9 }).ok).toBe(true);
  expect(serializer.serialize().ok).toBe(true);
  expect(serializer.instrumentation.shapeBuilds).toBe(2);
  expect(serializer.resetRuntime({ ...runtime, elements: [], revision: 10 }).ok).toBe(true);
  expect(serializer.instrumentation.shapeCacheElements).toBe(0);
});

it("reuses retired pressure geometry after Undo transfers a new point buffer", () => {
  const original = stroke();
  const source = copySnapshotToRuntime(
    createSnapshot([{ ...original, style: { ...original.style, pressureEnabled: true } }]),
  );
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.resetRuntime(source).ok).toBe(true);
  const initial = serializer.serialize();
  if (!initial.ok) throw new Error(initial.error.code);
  const removedId = original.id;
  expect(
    serializer.applyDelta({ baseModelRevision: 7, modelRevision: 8, removedIds: [removedId] }).ok,
  ).toBe(true);
  expect(serializer.instrumentation).toMatchObject({ cacheElements: 0, shapeCacheElements: 1 });
  expect(serializer.serialize().ok).toBe(true);
  const restored = source.elements[0]!;
  if (restored.kind !== "stroke") throw new Error("Expected a stroke");
  const transferred = {
    ...restored,
    points: adoptTransferredStrokeSamples(new Float64Array(restored.points)),
  };
  expect(
    serializer.applyDelta({
      baseModelRevision: 8,
      changedElements: [transferred],
      modelRevision: 9,
      orderChanges: { content: [removedId] },
    }).ok,
  ).toBe(true);
  const restoredOutput = serializer.serialize();
  if (!restoredOutput.ok) throw new Error(restoredOutput.error.code);
  const staticSuffix = (svg: string) => {
    const start = svg.indexOf('<g id="inkbook-background">');
    if (start < 0) throw new Error("Missing static SVG bands");
    return svg.slice(start);
  };
  expect(staticSuffix(restoredOutput.value.svg)).toBe(staticSuffix(initial.value.svg));
  expect(serializer.instrumentation.shapeBuilds).toBe(1);
  expect(serializer.instrumentation.shapeCacheElements).toBe(1);
  expect(serializer.instrumentation.retiredPointComparisons).toBe(restored.points.length);

  const changedPointBuffer = new Float64Array(restored.points);
  changedPointBuffer[0] = changedPointBuffer[0]! + 0.001;
  const changedPoints = adoptTransferredStrokeSamples(changedPointBuffer);
  expect(
    serializer.applyDelta({ baseModelRevision: 9, modelRevision: 10, removedIds: [removedId] }).ok,
  ).toBe(true);
  expect(
    serializer.applyDelta({
      baseModelRevision: 10,
      changedElements: [{ ...restored, points: changedPoints }],
      modelRevision: 11,
      orderChanges: { content: [removedId] },
    }).ok,
  ).toBe(true);
  expect(serializer.instrumentation.shapeBuilds).toBe(2);
  expect(serializer.instrumentation.retiredPointComparisons).toBe(restored.points.length + 1);
  serializer.clear();
  expect(serializer.instrumentation.shapeCacheElements).toBe(0);
});

it("compares point values only for retired shapes", () => {
  const original = stroke();
  const cache = new StrokeShapeCache();
  const first = cache.resolve(original);
  expect(cache.resolve({ ...original, points: [...original.points] })).not.toBe(first);
  cache.retire(original.id);
  const restored = { ...original, points: [...original.points] };
  const second = cache.resolve(restored);
  expect(cache.resolve({ ...restored, style: { ...restored.style, opacity: 0.4 } })).toBe(second);
  expect(cache.instrumentation.shapeBuilds).toBe(2);
  expect(cache.instrumentation.retiredPointComparisons).toBe(original.points.length);
});

it("invalidates only changed local geometry and releases deleted stroke entries", () => {
  const original = stroke();
  const cache = new StrokeShapeCache();
  const initial = cache.resolve(original);
  expect(cache.resolve({ ...original, style: { ...original.style, opacity: 0.2 } })).toBe(initial);
  const wider = { ...original, style: { ...original.style, width: 14 as const } };
  expect(cache.resolve(wider)).not.toBe(initial);
  cache.resolve({ ...wider, rotation: 0.5 });
  cache.resolve({ ...wider, points: [...wider.points] });
  expect(cache.instrumentation.shapeBuilds).toBe(4);
  expect(cache.instrumentation.shapeCacheElements).toBe(1);
  cache.remove(original.id);
  cache.remove(original.id);
  expect(cache.instrumentation.shapeCacheBytes).toBe(0);
});

it.each([0, 0.37, 1.25])(
  "reuses exact local bounds at fractional placements, rotation=%s",
  (rotation) => {
    const original = {
      ...stroke(),
      rotation,
      points: [51.123, 240.456, 0.5, 62.345, 252.789, 0.7, 80.125, 270.375, 0.4],
    };
    let facts = elementFacts(original);
    for (const offset of [
      { x: 0.123, y: 12.007 },
      { x: -0.007, y: 25.001 },
      { x: 0, y: 0 },
    ]) {
      const moved = {
        ...original,
        offset,
        pivot: { x: original.pivot.x + offset.x, y: original.pivot.y + offset.y },
      };
      const changed = validatedDeltaElementFacts(moved, undefined, facts);
      expect(changed).toEqual(elementFacts(moved));
      expect(changed.strokeGeometry?.bounds).toBe(facts.strokeGeometry?.bounds);
      expect(changed.bottom).toBe(calculateElementBounds(moved).maxY);
      facts = changed;
    }
  },
);
