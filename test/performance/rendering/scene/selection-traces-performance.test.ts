import { afterEach, describe, expect, it, vi } from "vitest";
import * as strokePath from "../../../../src/domain/geometry/stroke-path";
import { ElementStore } from "../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { createMountedElement } from "../../../../src/rendering/scene/mounted-element";
import { SceneSelectionTraces } from "../../../../src/rendering/scene/selection-traces";
import { createSceneFixture, createSceneRecord } from "../../../fixtures/rendering/scene";
import {
  createSelectionTraceFixture,
  selectionTraceNodes,
  selectionCenterPaths,
  selectionHaloNodes,
} from "../../../fixtures/rendering/selection-traces";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { arrow, line } from "../../../unit/domain/schema/fixtures";
import { createSnapshot } from "../../../unit/persistence/serialization/fixtures";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  fakeNode,
} from "../../../unit/rendering/scene/fakes";
import { maximumStroke } from "../../editor/maximum-stroke-fixture";

afterEach(() => vi.restoreAllMocks());

function traceRemovalWork(
  remove: { mock: { contexts: unknown[]; invocationCallOrder: number[] } },
  append: { mock: { calls: unknown[][]; invocationCallOrder: number[] } },
  group: FakeNode,
): { batches: number; connected: number; removed: number } {
  const groupOrders = remove.mock.contexts.flatMap((node, index) =>
    node === group ? [remove.mock.invocationCallOrder[index]!] : [],
  );
  const traceOrders = remove.mock.contexts.flatMap((node, index) =>
    node instanceof FakeNode && node.attributes.has("data-selection-element-id")
      ? [remove.mock.invocationCallOrder[index]!]
      : [],
  );
  const attachOrders = append.mock.calls.flatMap(([node], index) =>
    node === group ? [append.mock.invocationCallOrder[index]!] : [],
  );
  expect(attachOrders).toHaveLength(groupOrders.length);
  const connected = traceOrders.filter(
    (order) =>
      !groupOrders.some((detached, index) => detached < order && order < attachOrders[index]!),
  ).length;
  return { batches: groupOrders.length, connected, removed: traceOrders.length };
}

it("reuses retained center geometry across camera, move, rotation and ink opacity", () => {
  let reads = 0;
  const source = maximumStroke(0);
  const points = new Proxy(source.points, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const element = { ...source, points };
  const { renderer, select, scheduler, store } = createSelectionTraceFixture([element]);
  reads = 0;
  const builds = vi.spyOn(strokePath, "buildStrokePathParts");
  select();
  expect(builds).toHaveBeenCalledTimes(1);
  expect(reads).toBeGreaterThan(0);
  expect(reads).toBeLessThanOrEqual((source.points.length / 3) * 10);
  const svg = fakeNode(renderer.svg);
  const [path] = selectionCenterPaths(svg);
  expect(path).toBeDefined();
  const writes = vi.spyOn(path!, "setAttribute");
  builds.mockClear();
  reads = 0;
  renderer.resetInstrumentation();
  for (const [version, transform] of [
    "translate(10 0)",
    "rotate(30 10 10)",
    "scale(2 1)",
  ].entries()) {
    renderer.setPreviewTransform([element.id], transform, version, "preserve");
    renderer.flushPointerFeedbackFrame();
    expect(path!.attributes.get("transform")).toBe(transform);
  }
  renderer.clearPreviewTransforms();
  renderer.setCamera({ x: 1, zoom: 2 });
  scheduler.runAll();
  const record = store.get(element.id)!;
  store.records.set(element.id, {
    ...record,
    element: { ...element, style: { ...element.style, opacity: 0.2 } },
    paintVersion: 2,
  });
  renderer.applyDelta({ affected: [{ id: element.id, domains: ["paint"] }] });
  scheduler.runAll();
  expect(reads).toBe(0);
  expect(builds).not.toHaveBeenCalled();
  expect(renderer.instrumentation().selectionTraceGeometryBuilds).toBe(0);
  expect(writes.mock.calls.every(([name]) => name === "transform")).toBe(true);
  expect(selectionCenterPaths(svg)).toEqual([path]);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it("reuses center geometry after culling without retaining offscreen DOM", () => {
  const { renderer, scheduler, select, nodes } = createSelectionTraceFixture([maximumStroke(0)]);
  select();
  const builds = vi.spyOn(strokePath, "buildStrokePathParts");
  renderer.setCamera({ x: 5000, zoom: 1 });
  scheduler.runAll();
  expect(nodes()).toHaveLength(0);
  renderer.setCamera({ x: 0, zoom: 1 });
  scheduler.runAll();
  expect(nodes()).toHaveLength(1);
  expect(builds).not.toHaveBeenCalled();
  renderer.destroy();
  expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
});

it("reuses 1000 mixed short and long selected centers after culling", () => {
  const elements = Array.from({ length: 1000 }, (_, index) => {
    const x = 20 + (index % 20) * 2;
    const y = 20 + Math.floor(index / 20);
    const count = [12, 64, 256][index % 3]!;
    return {
      ...indexedStroke(index),
      pivot: { x, y },
      points: Array.from({ length: count }, (_, sample) => [
        x + sample / 8,
        y + Math.sin(sample / 8),
        0.35 + (sample % 10) / 20,
      ]).flat(),
    };
  });
  const { renderer, scheduler, select, nodes } = createSelectionTraceFixture(elements);
  const builds = vi.spyOn(strokePath, "buildStrokePathParts");
  select();
  expect(nodes()).toHaveLength(1000);
  expect(builds).toHaveBeenCalledTimes(1000);
  const roots = nodes();
  const group = roots[0]!.parent!;
  const parent = group.parent!;
  const siblings = [...parent.nodes];
  const remove = vi.spyOn(FakeNode.prototype, "remove");
  const append = vi.spyOn(parent, "appendChild");
  renderer.setSelectedElements(
    new Set(roots.slice(0, 500).map((root) => root.attributes.get("data-selection-element-id")!)),
  );
  scheduler.runAll();
  expect(nodes()).toEqual(roots.slice(0, 500));
  expect(parent.nodes).toEqual(siblings);
  expect(traceRemovalWork(remove, append, group)).toEqual({
    batches: 1,
    connected: 0,
    removed: 500,
  });
  remove.mockClear();
  append.mockClear();
  renderer.setCamera({ x: 5000, zoom: 1 });
  scheduler.runAll();
  expect(nodes()).toHaveLength(0);
  expect(parent.nodes).toEqual(siblings);
  const cullWork = traceRemovalWork(remove, append, group);
  expect(cullWork.removed).toBe(500);
  expect(cullWork.batches).toBeLessThanOrEqual(2);
  expect(cullWork.connected).toBe(0);
  builds.mockClear();
  renderer.resetInstrumentation();
  renderer.setSelectedElements(new Set(elements.map(({ id }) => id)));
  renderer.setCamera({ x: 0, zoom: 1 });
  scheduler.runAll();
  expect(nodes()).toHaveLength(1000);
  expect(renderer.instrumentation().selectionTraceGeometryBuilds).toBe(0);
  expect(builds).not.toHaveBeenCalled();
  renderer.destroy();
  expect(group.nodes).toEqual([]);
  expect(parent.nodes).toEqual(siblings);
  expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
});

it("spends sample budget only on center builds while preserving the 64-root frame cap", () => {
  const document = new FakeDocument();
  const group = new FakeNode(document, "g");
  const frame = new FakeNode(document, "path");
  const instrumentation = createInstrumentation();
  const traces = new SceneSelectionTraces(
    group as unknown as SVGGElement,
    instrumentation,
    frame as unknown as SVGPathElement,
  );
  const store = new FakeSceneStore();
  let pointReads = 0;
  const elements = Array.from({ length: 96 }, (_, index) => {
    const source = indexedStroke(index);
    const points = new Proxy(
      Array.from({ length: 192 }, (_, sample) => [sample, index, 0.5]).flat(),
      {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) pointReads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    return { ...source, points };
  });
  const mounted = new Map(
    elements.map((element, index) => {
      const record = createSceneRecord(element, index);
      store.records.set(record.id, record);
      return [
        record.id,
        createMountedElement(
          document as unknown as Document,
          record,
          [{ d: "M0 0L1 1", paint: "fill" }],
          instrumentation,
        ),
      ] as const;
    }),
  );
  const ids = new Set(elements.map(({ id }) => id));
  const builds = vi.spyOn(strokePath, "buildStrokePathParts");
  traces.setSelection(ids);
  const dirty = new Set(ids);
  pointReads = 0;
  expect(traces.writeDirty(dirty, mounted, store, Infinity, () => 0, { remainingRoots: 0 })).toBe(
    true,
  );
  expect(dirty.size).toBe(96);
  expect(builds).not.toHaveBeenCalled();
  expect(pointReads).toBe(0);

  const drain = () => {
    let frames = 0;
    while (dirty.size > 0) {
      const before = instrumentation.selectionTraceNodesCreated;
      const budget = { remainingRoots: 64 };
      const pending = traces.writeDirty(dirty, mounted, store, Infinity, () => 0, budget);
      expect(instrumentation.selectionTraceNodesCreated - before).toBeLessThanOrEqual(64);
      expect(pending).toBe(dirty.size > 0);
      frames += 1;
      if (frames > 10) throw new Error("Selection trace publication did not complete.");
    }
    return frames;
  };
  expect(drain()).toBeGreaterThan(2);
  expect(builds).toHaveBeenCalledTimes(96);
  expect(pointReads).toBeGreaterThan(0);

  builds.mockClear();
  pointReads = 0;
  for (const id of ids) dirty.add(id);
  expect(drain()).toBe(1);
  expect(builds).not.toHaveBeenCalled();
  expect(pointReads).toBe(0);

  traces.setSelection(new Set());
  traces.flushContext();
  expect(group.nodes).toHaveLength(0);
  traces.setSelection(ids);
  for (const id of ids) dirty.add(id);
  expect(drain()).toBe(2);
  expect(builds).not.toHaveBeenCalled();
  expect(pointReads).toBe(0);
  traces.release();
  expect(group.nodes).toHaveLength(0);
  expect(traces.memoryUsage()).toBe(0);
});

it("selects 10000 IDs using only mounted centers and releases them after culling", () => {
  const elements = Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));
  const store = new ElementStore(elements);
  const { renderer, scheduler } = createSceneFixture(
    createSnapshot().page,
    new ElementSceneStore(store),
    { height: 100, left: 0, top: 0, width: 100 },
  );
  scheduler.runAll();
  const builds = vi.spyOn(strokePath, "buildStrokePathParts");
  store.resetInstrumentation();
  renderer.resetInstrumentation();
  renderer.setSelectedElements(new Set(elements.map(({ id }) => id)));
  scheduler.runAll();
  const svg = fakeNode(renderer.svg);
  const roots = selectionTraceNodes(svg);
  expect(roots.length).toBeGreaterThan(0);
  expect(roots).toHaveLength(renderer.mountedCount);
  expect(roots.length).toBeLessThanOrEqual(1200);
  expect(selectionCenterPaths(svg)).toHaveLength(roots.length);
  expect(builds.mock.calls.length).toBeLessThanOrEqual(roots.length);
  expect(renderer.instrumentation().selectionTraceNodesCreated).toBe(roots.length);
  expect(store.instrumentation.fullStoreScans).toBe(0);
  expect(store.instrumentation.snapshotMaterializations).toBe(0);
  expect(
    selectionHaloNodes(svg).some(({ tagName }) => tagName === "filter" || tagName === "clipPath"),
  ).toBe(false);
  renderer.setCamera({ x: -5000, zoom: 1 });
  scheduler.runAll();
  expect(selectionTraceNodes(svg)).toEqual([]);
  expect(roots.every((root) => root.parent === undefined)).toBe(true);
  renderer.destroy();
  expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
});

describe("selection center scheduling and ownership", () => {
  it.each([false, true])(
    "shows essential frame before budgeted maximum-stroke centers (reduced: %s)",
    (reduced) => {
      const elements = [0, 1, 2].map((index) => maximumStroke(index));
      const { renderer, scheduler, nodes } = createSelectionTraceFixture(elements);
      const baseline = renderer.memoryUsage().pathCacheBytes;
      renderer.setReducedMotion(reduced);
      renderer.resetInstrumentation();
      renderer.setSelectedElements(new Set(elements.map(({ id }) => id)));
      renderer.setSelectionOverlayPath("M0 0L10 0L10 10Z", "accent", "M0 0L1 1");
      scheduler.runNext();
      const overlay = fakeNode(renderer.svg).nodes[2]!;
      expect(overlay.nodes[1]!.style.opacity).toBe("1");
      expect(overlay.nodes[2]!.style.opacity).toBe("1");
      expect(nodes()).toHaveLength(1);
      expect(renderer.instrumentation().selectionTraceGeometryBuilds).toBe(1);
      expect(renderer.instrumentation().selectionTraceNodesCreated).toBe(1);
      expect(scheduler.pendingCount).toBe(1);
      renderer.setSelectedElements(new Set());
      scheduler.runAll();
      expect(nodes()).toEqual([]);
      expect(renderer.memoryUsage().pathCacheBytes).toBeGreaterThan(baseline);
      renderer.destroy();
    },
  );

  it("bounds owned center strings and reuses them after deselection", () => {
    const { renderer, select } = createSelectionTraceFixture([maximumStroke(0)]);
    const baseline = renderer.memoryUsage().pathCacheBytes;
    const [root] = select();
    const d = selectionCenterPaths(root!)[0]!.attributes.get("d")!;
    const bytes = renderer.memoryUsage().pathCacheBytes - baseline;
    expect(bytes).toBeGreaterThanOrEqual(d.length * 2);
    expect(bytes).toBeLessThan(d.length * 4 + 1536);
    select([]);
    expect(renderer.memoryUsage().pathCacheBytes).toBeGreaterThan(baseline);
    renderer.resetInstrumentation();
    select();
    expect(renderer.instrumentation().selectionTraceGeometryBuilds).toBe(0);
    renderer.destroy();
    expect(renderer.memoryUsage().pathCacheBytes).toBe(0);
  });
});

it("skips disabled pressure centers and retains line/arrow nodes across toggles", () => {
  const elements = [maximumStroke(0), line(), arrow()];
  const { renderer, scheduler, select, nodes } = createSelectionTraceFixture(elements);
  renderer.setSelectionHighlightsEnabled(false);
  const builds = vi.spyOn(strokePath, "buildStrokePathParts");
  const roots = select();
  expect(roots).toHaveLength(2);
  expect(builds).not.toHaveBeenCalled();
  const centers = roots;
  renderer.setSelectionHighlightsEnabled(true);
  scheduler.runAll();
  expect(nodes()).toHaveLength(3);
  expect(builds).toHaveBeenCalledTimes(1);
  renderer.setSelectionHighlightsEnabled(false);
  scheduler.runAll();
  expect(nodes()).toEqual(roots);
  renderer.setPreviewTransform(
    elements.map(({ id }) => id),
    "translate(5 10)",
    1,
  );
  renderer.flushPointerFeedbackFrame();
  expect(centers.every((center) => center.attributes.get("transform") === "translate(5 10)")).toBe(
    true,
  );
  select([]);
  expect(nodes()).toEqual([]);
  renderer.destroy();
  expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
});
