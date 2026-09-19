import { afterEach, describe, expect, it, vi } from "vitest";

import * as strokePath from "../../../../src/domain/geometry/stroke-path";
import * as presentation from "../../../../src/rendering/scene/element-presentation";
import { scaleElement } from "../../../../src/editor/selection/transforms";
import { ElementStore } from "../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import {
  createSelectionTraceFixture,
  selectionTraceNodes,
  selectionHaloPaths,
  selectionTraceGeometry,
  selectionTraceTransform,
  selectionHaloNodes,
} from "../../../fixtures/rendering/selection-traces";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { arrow, line } from "../../../unit/domain/schema/fixtures";
import { createSnapshot } from "../../../unit/persistence/serialization/fixtures";
import { fakeNode } from "../../../unit/rendering/scene/fakes";
import { maximumStroke } from "../../editor/maximum-stroke-fixture";

afterEach(() => vi.restoreAllMocks());

describe("selection trace paint invalidation", () => {
  it("repaints retained outlines only when their effective scale or paint changes", () => {
    const elements = Array.from({ length: 100 }, (_, index) => {
      const element = line(index);
      return { ...element, style: { ...element.style, outlineStyle: "dashed" as const } };
    });
    const { renderer, select, scheduler } = createSelectionTraceFixture(elements);
    select();
    const paints = vi.spyOn(presentation, "pathPresentation");
    const ids = elements.map(({ id }) => id);
    for (const [version, offset] of [10, -10, 0].entries()) {
      renderer.setPreviewTransform(ids, `translate(${String(offset)} 0)`, version);
      renderer.flushPointerFeedbackFrame();
    }
    renderer.setCamera({ x: 1, zoom: 1 });
    renderer.flushPointerFeedbackFrame();
    expect(paints).not.toHaveBeenCalled();
    renderer.setCamera({ x: 1, zoom: 2 });
    renderer.flushPointerFeedbackFrame();
    expect(paints).toHaveBeenCalledTimes(elements.length);
    paints.mockClear();
    renderer.setPreviewTransform(ids, "scale(2 1)", 4, "preserve");
    renderer.flushPointerFeedbackFrame();
    expect(paints).not.toHaveBeenCalled();
    renderer.setCamera({ x: 1, zoom: 3 });
    renderer.flushPointerFeedbackFrame();
    expect(paints).not.toHaveBeenCalled();
    renderer.setPreviewTransform(ids, "scale(1 2)", 5, "preserve");
    renderer.flushPointerFeedbackFrame();
    expect(paints).toHaveBeenCalledTimes(elements.length);
    paints.mockClear();
    renderer.clearPreviewTransforms();
    renderer.flushPointerFeedbackFrame();
    expect(paints).not.toHaveBeenCalled();
    renderer.setSelectionHighlightsEnabled(false);
    scheduler.runAll();
    expect(paints).not.toHaveBeenCalled();
    renderer.setSelectionHighlightsEnabled(true);
    scheduler.runAll();
    expect(paints).toHaveBeenCalledTimes(elements.length);
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe("selection trace work and ownership", () => {
  it("selects 10,000 IDs while building only mounted traces and releases them after culling", () => {
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
    renderer.setSelectedElements(new Set(elements.map(({ id }) => id)));
    scheduler.runAll();
    const traces = selectionTraceNodes(fakeNode(renderer.svg));
    expect(traces).toHaveLength(renderer.mountedCount);
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.length).toBeLessThanOrEqual(1_200);
    const retainedNodes = traces.reduce((sum, trace) => sum + selectionHaloNodes(trace).length, 0);
    expect(retainedNodes).toBe(traces.length * 4);
    expect(renderer.instrumentation().selectionTraceNodesCreated).toBe(
      retainedNodes + traces.length + 4,
    );
    const filters = selectionHaloNodes(fakeNode(renderer.svg)).filter(
      ({ tagName }) => tagName === "filter",
    );
    expect(filters).toHaveLength(1);
    expect(filters[0]!.nodes).toHaveLength(2);
    expect(
      Number(filters[0]!.attributes.get("width")) * Number(filters[0]!.attributes.get("height")),
    ).toBeLessThanOrEqual(106 * 106);
    expect(builds).not.toHaveBeenCalled();
    expect(store.instrumentation.fullStoreScans).toBe(0);
    expect(store.instrumentation.snapshotMaterializations).toBe(0);
    renderer.setCamera({ x: -5_000, zoom: 1 });
    scheduler.runAll();
    expect(selectionTraceNodes(fakeNode(renderer.svg))).toEqual([]);
    expect(traces.every((trace) => trace.parent === undefined)).toBe(true);
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
  });

  it("reuses maximum pressure contours across move, zoom, and progressive resize feedback", () => {
    const source = maximumStroke(0);
    const { renderer, scheduler, select, nodes, store } = createSelectionTraceFixture([source]);
    const builds = vi.spyOn(strokePath, "buildStrokePathParts");
    const [trace] = select();
    expect(builds).not.toHaveBeenCalled();
    const writes = vi.spyOn(selectionHaloPaths(trace!)[0]!, "setAttribute");
    const transformWrites = vi.spyOn(selectionHaloPaths(trace!)[0]!.parent!, "setAttribute");
    builds.mockClear();
    const record = store.get(source.id)!;
    store.records.set(source.id, {
      ...record,
      paintVersion: 2,
      element: { ...source, style: { ...source.style, opacity: 0.5 } },
    });
    renderer.applyDelta({ affected: [{ id: source.id, domains: ["paint"] }] });
    scheduler.runAll();
    expect(builds).not.toHaveBeenCalled();
    for (const [index, delta] of [1, 20, -5].entries()) {
      renderer.setPreviewTransform([source.id], `translate(${delta} 0)`, index + 1);
      renderer.flushPointerFeedbackFrame();
    }
    renderer.setCamera({ x: 10, zoom: 2 });
    scheduler.runAll();
    renderer.clearPreviewTransforms();
    const resized = scaleElement(source, { x: 0, y: 0 }, { x: 2, y: 1 });
    renderer.setProgressiveElementPreviews([source.id], () => resized, 10, {
      transform: "scale(2 1)",
      inverse: "scale(0.5 1)",
    });
    renderer.flushPointerFeedbackFrame();
    expect(nodes()).toEqual([trace]);
    expect(selectionTraceTransform(trace!)).toContain("scale(2 1)");
    expect(builds).not.toHaveBeenCalled();
    expect(writes.mock.calls.filter(([name]) => name === "d")).toHaveLength(0);
    expect(
      transformWrites.mock.calls.filter(([name]) => name === "transform").length,
    ).toBeLessThanOrEqual(5);
    scheduler.runAll();
    expect(builds).not.toHaveBeenCalled();
    expect(writes.mock.calls.filter(([name]) => name === "d")).toHaveLength(1);
    expect(selectionTraceGeometry(nodes()[0]!)).not.toBe("");
    renderer.clearProgressiveElementPreviews();
    select([]);
    expect(nodes()).toEqual([]);
    expect(trace!.parent).toBeUndefined();
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe("selection trace scheduling and retained memory", () => {
  it("slices maximum pressure traces, cancels queued selection, and releases accounted paths", () => {
    const elements = [0, 1, 2].map((index) => maximumStroke(index));
    const { renderer, scheduler, nodes } = createSelectionTraceFixture(elements);
    const baseline = renderer.memoryUsage().pathCacheBytes;
    const ids = new Set(elements.map(({ id }) => id));
    renderer.resetInstrumentation();
    renderer.setSelectedElements(ids);
    scheduler.runNext();
    expect(nodes()).toHaveLength(1);
    expect(renderer.instrumentation().selectionTraceGeometryBuilds).toBe(0);
    expect(scheduler.pendingCount).toBe(1);
    renderer.setSelectedElements(new Set());
    scheduler.runAll();
    expect(nodes()).toEqual([]);
    expect(renderer.memoryUsage().pathCacheBytes).toBe(baseline);
    expect(renderer.instrumentation().selectionTraceNodesRemoved).toBe(9);
    renderer.setSelectedElements(ids);
    scheduler.runAll();
    const traces = nodes();
    expect(traces).toHaveLength(3);
    const pathBytes = traces.reduce(
      (sum, trace) => sum + selectionTraceGeometry(trace).length * 2,
      0,
    );
    const retained = renderer.memoryUsage().pathCacheBytes - baseline;
    expect(retained).toBeGreaterThanOrEqual(pathBytes);
    expect(retained).toBeLessThanOrEqual(
      pathBytes +
        (traces.reduce((sum, trace) => sum + selectionHaloNodes(trace).length + 1, 0) + 4) * 512,
    );
    renderer.setSelectedElements(new Set());
    scheduler.runAll();
    expect(renderer.memoryUsage().pathCacheBytes).toBe(baseline);
    renderer.destroy();
    expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
    expect(scheduler.pendingCount).toBe(0);
  });
});

it("skips disabled pressure work, cancels queued highlights, and reclaims their memory", () => {
  const elements = [0, 1, 2].map((index) => maximumStroke(index));
  const { renderer, scheduler, nodes } = createSelectionTraceFixture(elements);
  const baseline = renderer.memoryUsage().pathCacheBytes;
  const builds = vi.spyOn(strokePath, "buildStrokePathParts");
  renderer.resetInstrumentation();
  renderer.setSelectionHighlightsEnabled(false);
  renderer.setSelectedElements(new Set(elements.map(({ id }) => id)));
  scheduler.runAll();
  expect(nodes()).toEqual([]);
  expect(builds).not.toHaveBeenCalled();
  expect(renderer.instrumentation().selectionTraceNodesCreated).toBe(0);
  expect(renderer.memoryUsage().pathCacheBytes).toBe(baseline);
  renderer.setSelectionHighlightsEnabled(true);
  scheduler.runNext();
  expect(nodes()).toHaveLength(1);
  expect(builds).not.toHaveBeenCalled();
  renderer.setSelectionHighlightsEnabled(false);
  scheduler.runAll();
  expect(nodes()).toEqual([]);
  expect(builds).not.toHaveBeenCalled();
  expect(renderer.memoryUsage().pathCacheBytes).toBe(baseline);
  renderer.setSelectionHighlightsEnabled(true);
  scheduler.runAll();
  expect(nodes()).toHaveLength(3);
  expect(builds).not.toHaveBeenCalled();
  renderer.resetInstrumentation();
  renderer.setSelectionHighlightsEnabled(true);
  scheduler.runAll();
  expect(builds).not.toHaveBeenCalled();
  expect(renderer.instrumentation().selectionTraceAttributeWrites).toBe(0);
  renderer.destroy();
  expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
  expect(scheduler.pendingCount).toBe(0);
});

it("allocates only center nodes with halos disabled and releases every halo resource on toggles", () => {
  const elements = [line(), arrow()];
  const { renderer, scheduler, select, nodes } = createSelectionTraceFixture(elements);
  const baseline = renderer.memoryUsage().pathCacheBytes;
  renderer.setSelectionHighlightsEnabled(false);
  renderer.resetInstrumentation();
  const roots = select();
  const centers = roots.map((root) => root.nodes[0]!);
  expect(roots.every((root) => root.nodes.length === 1)).toBe(true);
  expect(renderer.instrumentation().selectionTraceNodesCreated).toBe(elements.length * 2);
  const centerBytes = renderer.memoryUsage().pathCacheBytes;
  renderer.setSelectionHighlightsEnabled(true);
  scheduler.runAll();
  const haloNodes = selectionHaloNodes(roots[0]!.parent!)
    .slice(1)
    .filter((node) => !roots.includes(node) && !centers.includes(node));
  expect(haloNodes.length).toBeGreaterThan(0);
  expect(renderer.memoryUsage().pathCacheBytes).toBeGreaterThan(centerBytes);
  renderer.resetInstrumentation();
  renderer.setSelectionHighlightsEnabled(false);
  scheduler.runAll();
  expect(renderer.instrumentation().selectionTraceNodesRemoved).toBe(haloNodes.length);
  expect(haloNodes.every((node) => node.parent === undefined)).toBe(true);
  expect(roots.map((root) => root.nodes[0]!)).toEqual(centers);
  expect(renderer.memoryUsage().pathCacheBytes).toBe(centerBytes);
  expect(nodes().flatMap(selectionHaloPaths)).toEqual([]);
  renderer.resetInstrumentation();
  renderer.setPreviewTransform(
    elements.map(({ id }) => id),
    "translate(5 10)",
    1,
  );
  renderer.flushPointerFeedbackFrame();
  expect(centers.every((node) => node.attributes.get("transform") === "translate(5 10)")).toBe(
    true,
  );
  expect(renderer.instrumentation().selectionTraceNodesCreated).toBe(0);
  renderer.clearPreviewTransforms();
  scheduler.runAll();
  select([]);
  expect(renderer.memoryUsage().pathCacheBytes).toBe(baseline);
  renderer.destroy();
});
