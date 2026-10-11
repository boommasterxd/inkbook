import type { PressureWindow } from "../../../../src/domain/geometry/prepared-pressure-geometry";
import * as pressureUnion from "../../../../src/domain/geometry/pressure-union";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { scaleElement } from "../../../../src/editor/selection/transforms";
import { rectangle } from "../../../unit/domain/store/fixtures";
import { afterEach, expect, it, vi } from "vitest";
import * as elementPath from "../../../../src/domain/geometry/element-path";
import { ProgressivePreviewPath } from "../../../../src/rendering/scene/progressive-preview-path";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import { createSceneFixture, createSceneRecord } from "../../../fixtures/rendering/scene";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";
import { FakeSceneStore, fakeNode } from "../../../unit/rendering/scene/fakes";

afterEach(() => vi.restoreAllMocks());

function pendingCommit(extras: readonly InkElementV1[] = [], selected = false) {
  const store = new FakeSceneStore();
  const windows = new Map<string, PressureWindow>();
  const pressureGeometry = (id: string, version: number) => ({
    readWindow: (index: number) => windows.get(`${id}:${version}:${index}`),
    publishWindow: (index: number, window: PressureWindow) => {
      windows.set(`${id}:${version}:${index}`, window);
    },
  });
  Object.assign(store, { pressureGeometry });
  const element = {
    ...indexedStroke(1),
    points: Array.from({ length: 4096 }, (_, i) => [i / 10, 20 + (i % 7), 0.5]).flat(),
  };
  // Match the authoritative Store's immutable samples for contour identity reuse.
  Object.freeze(element.points);
  const elements = [element, ...extras];
  const ids = elements.map(({ id }) => id);
  for (const [rank, value] of elements.entries())
    store.records.set(value.id, createSceneRecord(value, rank));
  const { renderer, scheduler } = createSceneFixture(createWorkerSnapshot([]).page, store);
  scheduler.runAll();
  if (selected) {
    renderer.setSelectedElements(new Set(ids));
    scheduler.runAll();
  }
  const group = fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes[0]!;
  const original = group.nodes[0]!.attributes.get("d");
  renderer.setPreviewTransform(ids, "scale(1.1 1)", 1);
  renderer.flushPointerFeedbackFrame();
  const handoff = renderer.beginPreviewCommit();
  handoff.arm(ids);
  renderer.clearPreviewTransforms();
  const replacements = elements.map((value) =>
    scaleElement(value, { x: 0, y: 0 }, { x: 1.1, y: 1 }),
  );
  const moved = replacements[0]!;
  if (moved.kind !== "stroke") throw new Error("Expected moved stroke");
  for (const value of replacements)
    store.records.set(value.id, {
      ...store.records.get(value.id)!,
      element: value,
      geometryVersion: 2,
    });
  const fullBuild = vi.spyOn(elementPath, "buildElementPathParts");
  const originalStep = Reflect.get(ProgressivePreviewPath.prototype, "step");
  const step = vi.spyOn(ProgressivePreviewPath.prototype, "step");
  step.mockImplementation(function (this: ProgressivePreviewPath, deadline, now) {
    const complete = originalStep.call(this, deadline, now);
    scheduler.time += 1;
    return complete;
  });
  renderer.applyDelta({
    affected: replacements.map((after, index) => ({
      id: after.id,
      before: elements[index]!,
      after,
      domains: ["geometry"],
    })),
  });
  scheduler.runFrame();
  expect(step.mock.calls.length).toBeGreaterThan(0);
  expect(step.mock.calls.length).toBeLessThanOrEqual(8);
  expect(fullBuild).not.toHaveBeenCalled();
  expect(group.nodes[0]!.attributes.get("d")).toBe(original);
  expect(group.attributes.get("transform")).toBe("scale(1.1 1)");
  return {
    renderer,
    scheduler,
    element,
    moved,
    group,
    original,
    fullBuild,
    step,
    pressureGeometry,
    store,
  };
}

it("keeps committed feedback while preparing geometry and composes a subsequent gesture", () => {
  const {
    renderer,
    scheduler,
    element,
    moved,
    group,
    original,
    fullBuild,
    step,
    pressureGeometry,
    store,
  } = pendingCommit();
  renderer.setPreviewTransform([element.id], "translate(5 0)", 2);
  renderer.flushPointerFeedbackFrame();
  expect(group.attributes.get("transform")).toBe("translate(5 0) scale(1.1 1)");
  renderer.clearPreviewTransforms();
  renderer.flushPointerFeedbackFrame();
  expect(group.attributes.get("transform")).toBe("scale(1.1 1)");
  renderer.setPreviewTransform([element.id], "translate(5 0)", 3);
  renderer.flushPointerFeedbackFrame();
  while (scheduler.pendingCount > 0) {
    step.mockClear();
    scheduler.runFrame();
    expect(step.mock.calls.length).toBeLessThanOrEqual(8);
  }
  expect(fullBuild).not.toHaveBeenCalled();
  expect(group.nodes[0]!.attributes.get("d")).toBe(elementPath.buildElementPathParts(moved)[0]!.d);
  expect(group.attributes.get("transform")).toBe("translate(5 0)");
  const union = vi.spyOn(pressureUnion, "iteratePressureUnion");
  expect(elementPath.buildElementPathParts(moved, pressureGeometry(element.id, 2))[0]!.d).toBe(
    group.nodes[0]!.attributes.get("d"),
  );
  expect(union).not.toHaveBeenCalled();
  renderer.clearPreviewTransforms();
  scheduler.runAll();
  expect(group.attributes.has("transform")).toBe(false);
  const read = vi.spyOn(ScenePathCache.prototype, "read");
  store.records.set(element.id, {
    ...store.records.get(element.id)!,
    element,
    geometryVersion: 3,
  });
  renderer.applyDelta({
    affected: [{ id: element.id, before: moved, after: element, domains: ["geometry"] }],
  });
  scheduler.runAll();
  const access = read.mock.calls.findIndex(([value]) => value === element);
  expect(access).toBeGreaterThanOrEqual(0);
  expect(read.mock.calls[access]![2]).toBe(3);
  expect(read.mock.results[access]!.value).toBeDefined();
  const cache = read.mock.contexts[access]!;
  if (!(cache instanceof ScenePathCache)) throw new Error("Expected the scene contour cache.");
  expect(cache.has(element.id, 3)).toBe(true);
  expect(cache.has(element.id, 2)).toBe(false);
  expect(group.nodes[0]!.attributes.get("d")).toBe(original);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
  expect(renderer.memoryUsage().pathCacheBytes).toBe(0);
});

it("defers a new canonical preview until the committed geometry basis is current", () => {
  const { renderer, scheduler, moved, group, original, fullBuild } = pendingCommit();
  const newer = {
    ...moved,
    points: moved.points.map((value, index) => (index % 3 === 1 ? value + 20 : value)),
  };
  renderer.setElementPreviews([newer], 2);
  renderer.flushPointerFeedbackFrame();
  expect(group.nodes[0]!.attributes.get("d")).toBe(original);
  expect(group.attributes.get("transform")).toBe("scale(1.1 1)");
  expect(fullBuild).not.toHaveBeenCalled();
  while (scheduler.pendingCount > 0) scheduler.runFrame();
  expect(group.nodes[0]!.attributes.get("d")).toBe(elementPath.buildElementPathParts(newer)[0]!.d);
  expect(group.attributes.has("transform")).toBe(false);
  renderer.clearElementPreviews();
  scheduler.runAll();
  expect(group.nodes[0]!.attributes.get("d")).toBe(elementPath.buildElementPathParts(moved)[0]!.d);
  renderer.destroy();
});

it("releases pending committed work when the renderer is destroyed", () => {
  const { renderer, scheduler } = pendingCommit();
  expect(renderer.memoryUsage().pathCacheBytes).toBeGreaterThan(0);
  renderer.destroy();
  expect(renderer.memoryUsage().pathCacheBytes).toBe(0);
  expect(scheduler.pendingCount).toBe(0);
});

it("retains mixed constant-width ink and shapes while the preceding pressure job is pending", () => {
  const pen = indexedStroke(2);
  const constant = { ...pen, style: { ...pen.style, pressureEnabled: false } };
  const highlighter = { ...constant, id: indexedStroke(3).id, tool: "highlighter" as const };
  const { renderer, scheduler } = pendingCommit([
    constant,
    highlighter,
    rectangle(indexedStroke(4).id),
  ]);
  const camera = fakeNode(renderer.svg).nodes[1]!;
  const nodes = [...camera.nodes[3]!.nodes, ...camera.nodes[4]!.nodes];
  expect(nodes).toHaveLength(4);
  for (const node of nodes) expect(node.attributes.get("transform")).toBe("scale(1.1 1)");
  while (scheduler.pendingCount > 0) scheduler.runFrame();
  for (const node of nodes) expect(node.attributes.has("transform")).toBe(false);
  renderer.destroy();
});

it("drops committed preparation when its element is removed before publication", () => {
  const { renderer, scheduler, store, element, moved, step } = pendingCommit();
  store.records.delete(element.id);
  step.mockClear();
  renderer.applyDelta({
    affected: [
      { id: element.id, before: moved, after: null, domains: ["geometry", "visibility", "order"] },
    ],
  });
  scheduler.runAll();
  expect(step).not.toHaveBeenCalled();
  expect(renderer.mountedIds("content")).toEqual([]);
  // Reusable visibility-position markers remain until presentation disposal.
  renderer.destroy();
  expect(renderer.memoryUsage().pathCacheBytes).toBe(0);
});

it("finishes selection dismissal on schedule while canonical commit geometry remains pending", () => {
  const { renderer, scheduler, group, original } = pendingCommit();
  renderer.setSelectionOverlayPath("M0 0L100 0L100 50Z", "accent", "M0 0L5 5");
  renderer.flushPointerFeedbackFrame();
  const overlay = fakeNode(renderer.svg).nodes[2]!.nodes[1]!;
  const handles = fakeNode(renderer.svg).nodes[2]!.nodes[2]!;
  renderer.setSelectionOverlayPath(null);
  scheduler.runFrame();
  expect(handles.attributes.get("d")).toBe("M0 0L5 5");
  scheduler.time += 60;
  scheduler.runFrame();
  expect(Number(handles.style.opacity)).toBeLessThan(1);
  expect(group.nodes[0]!.attributes.get("d")).toBe(original);
  scheduler.time += 60;
  scheduler.runFrame();
  expect(handles.attributes.get("d")).toBe("");
  expect(overlay.attributes.get("d")).toBe("");
  expect(group.nodes[0]!.attributes.get("d")).toBe(original);
  renderer.destroy();
});

it("removes deselected stroke halos before pending committed geometry finishes", () => {
  const { renderer, scheduler, group, original } = pendingCommit([], true);
  const traces = fakeNode(renderer.svg).nodes[1]!.nodes[8]!;
  expect(traces.nodes.length).toBeGreaterThan(0);
  renderer.setSelectedElements(new Set());
  scheduler.runFrame();
  expect(group.nodes[0]!.attributes.get("d")).toBe(original);
  expect(traces.nodes).toHaveLength(0);
  renderer.destroy();
});
