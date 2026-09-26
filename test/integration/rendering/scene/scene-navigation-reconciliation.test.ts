import { expect, it, vi } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { FakeSceneStore, fakeNode, fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";

function createNavigationHarness() {
  const store = new FakeSceneStore();
  for (let index = 0; index < 1_201; index += 1) {
    const id = `rectangle-${index}`;
    store.records.set(id, fakeRectangleRecord(id, index, 10 + index / 1_000));
  }
  const { document, renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, {
    height: 100,
    left: 0,
    top: 0,
    width: 100,
  });
  const nodes = vi.spyOn(document, "createElementNS");
  return { nodes, renderer, scheduler, store };
}

it("retargets a pending viewport without recreating still-visible staged nodes", () => {
  const { nodes, renderer, scheduler, store } = createNavigationHarness();
  store.records.set("edge", fakeRectangleRecord("edge", 1_201, 190));
  scheduler.runNext();
  expect(renderer.mountedCount).toBe(64);
  const prepared = nodes.mock.calls.length;
  expect(prepared).toBeGreaterThan(0);
  expect(prepared).toBeLessThan(store.records.size);

  renderer.setCamera({ x: -50, zoom: 1 });
  scheduler.runAll();

  expect(renderer.mountedCount).toBe(store.records.size);
  expect(nodes.mock.calls.filter(([, tag]) => tag === "path")).toHaveLength(store.records.size);
  expect(renderer.instrumentation().geometryBuilds).toBe(store.records.size);
  expect(renderer.mountedIds("content")[store.records.size - 1]).toBe("edge");
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it("drops staged entries outside the new viewport and releases an interrupted mount", () => {
  const { nodes, renderer, scheduler } = createNavigationHarness();
  scheduler.runNext();
  expect(nodes.mock.calls.length).toBeGreaterThan(0);
  renderer.setViewport({ height: 100, left: 0, top: 10_000, width: 100 });
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(0);
  expect(fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes).toHaveLength(0);

  renderer.setViewport({ height: 100, left: 0, top: 0, width: 100 });
  scheduler.runNext();
  renderer.destroy();
  expect(renderer.mountedCount).toBe(0);
  expect(renderer.instrumentation().pathCacheEntries).toBe(0);
  expect(scheduler.pendingCount).toBe(0);
});

it("rejects stale staged geometry after a store delta during camera motion", () => {
  const { renderer, scheduler, store } = createNavigationHarness();
  scheduler.runNext();
  const id = "rectangle-1200";
  const before = store.records.get(id)!;
  const replacement = { ...fakeRectangleRecord(id, 1_200, 40), geometryVersion: 2 };
  store.records.set(id, replacement);
  renderer.applyDelta({
    affected: [{ id, domains: ["geometry"], before: before.element, after: replacement.element }],
  });
  renderer.setCamera({ x: -50, zoom: 1 });
  scheduler.runAll();

  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  expect(content.nodes[content.nodes.length - 1]?.attributes.get("d")).toBe(
    buildElementPathParts(replacement.element)[0]!.d,
  );
  expect(renderer.mountedCount).toBe(store.records.size);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it.each([true, false])(
  "rechecks retained exit candidates against the final viewport (returning=%s)",
  (returning) => {
    const { renderer, scheduler, store } = createNavigationHarness();
    store.records.set("edge", fakeRectangleRecord("edge", 1_201, 190));
    scheduler.runAll();
    const mounted = renderer.mountedCount;
    const now = vi.spyOn(scheduler, "now").mockImplementation(() => scheduler.time++);
    renderer.setCamera({ x: returning ? -1_000 : -50, zoom: 1 });
    scheduler.runNext();
    expect(renderer.mountedCount).toBe(mounted);
    renderer.setCamera({ x: returning ? 0 : -1_000, zoom: 1 });
    now.mockRestore();
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(returning ? mounted : 0);
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
  },
);
