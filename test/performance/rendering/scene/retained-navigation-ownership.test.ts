import { expect, it, vi } from "vitest";
import { BoundedVersionLru } from "../../../../src/domain/cache/bounded-version-lru";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { ConnectedRootOrder } from "../../../../src/rendering/scene/connected-root-order";
import { DETACHED_ELEMENT_CACHE_MAX_BYTES } from "../../../../src/rendering/scene/constants";
import { DetachedSceneElementCache } from "../../../../src/rendering/scene/detached-element-cache";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { createMountedElement } from "../../../../src/rendering/scene/mounted-element";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import {
  createSceneFixture,
  createSceneRecord,
  createViewportRectangleStore,
} from "../../../fixtures/rendering/scene";
import {
  asDocument,
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

it("retains 20,000 original roots below the byte limit without an independent count eviction", () => {
  const cache = new DetachedSceneElementCache();
  const document = new FakeDocument();
  const band = document.createElementNS("", "g");
  const store = new FakeSceneStore();
  const stats = createInstrumentation();
  const base = createTestStroke();
  const element = { ...base, style: { ...base.style, pressureEnabled: false } };
  const parts = buildElementPathParts(element);
  const remove = vi.spyOn(FakeNode.prototype, "remove");
  try {
    for (let rank = 0; rank < 20_000; rank += 1) {
      const id = `00000000-0000-4000-8000-${String(rank).padStart(12, "0")}`;
      const record = createSceneRecord({ ...element, id }, rank);
      const entry = createMountedElement(asDocument(document), record, parts, stats);
      store.records.set(record.id, record);
      band.append(...entry.paths.map((path) => fakeNode(path.node)));
      expect(cache.retainConnected(entry, store)).toBe(true);
    }
    expect(parts).toHaveLength(1);
    expect(cache.statistics()).toMatchObject({ entries: 20_000, evictions: 0 });
    expect(cache.statistics().bytes).toBeLessThan(DETACHED_ELEMENT_CACHE_MAX_BYTES);
    expect(cache.retainedRoots).toBe(20_000);
    expect(band.nodes).toHaveLength(20_000);
    expect(remove).not.toHaveBeenCalled();
    cache.setRetentionEnabled(false);
    let rounds = 0;
    while (cache.hasPendingCleanup) {
      remove.mockClear();
      cache.flushEvictions(10, () => 0, { remainingRoots: 64 });
      expect(remove.mock.calls.length).toBeLessThanOrEqual(64);
      rounds += 1;
    }
    expect(rounds).toBe(Math.ceil(20_000 / 64));
    expect(cache.memoryUsage()).toBe(0);
    expect(band.nodes).toHaveLength(0);
  } finally {
    cache.dispose();
    remove.mockRestore();
  }
});

it("transfers 10,000 warm connected roots without successor searches, LRU replacements, or DOM publication", () => {
  const store = createViewportRectangleStore(10_000, (rank) => (rank < 5_000 ? 50 : 1_000));
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  scheduler.runAll(200);
  renderer.setViewport({ ...viewport, top: 1_000 });
  scheduler.runAll(200);
  renderer.setViewport(viewport);
  scheduler.runAll(200);
  renderer.setViewport({ ...viewport, top: 1_000 });
  scheduler.runAll(200);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  const nodes = [...content.nodes];
  const successor = vi.spyOn(ConnectedRootOrder.prototype, "successor");
  const add = vi.spyOn(ConnectedRootOrder.prototype, "add");
  const set = vi.spyOn(BoundedVersionLru.prototype, "set");
  const read = vi.spyOn(FakeNode.prototype, "getAttribute");
  const insert = vi.spyOn(content, "insertBefore");
  try {
    for (const top of [0, 1_000, 100_000, 0, 1_000]) {
      renderer.resetInstrumentation();
      renderer.setViewport({ ...viewport, top });
      scheduler.runAll(200);
      expect(renderer.instrumentation()).toMatchObject({
        domEntrants: 0,
        domExits: 0,
        contentAttributeWrites: 0,
        geometryBuilds: 0,
      });
      expect(renderer.mountedCount).toBe(top === 100_000 ? 0 : 5_000);
      expect(content.nodes).toEqual(nodes);
      expect(renderer.instrumentation().detachedCacheBytes).toBeLessThan(
        DETACHED_ELEMENT_CACHE_MAX_BYTES,
      );
    }
    expect(successor).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(set.mock.calls.filter(([key]) => key.startsWith("\0"))).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  } finally {
    successor.mockRestore();
    add.mockRestore();
    set.mockRestore();
    read.mockRestore();
    insert.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
  expect(renderer.instrumentation().detachedCacheBytes).toBe(0);
  expect(fakeNode(renderer.svg).parent).toBeUndefined();
});

it.each(["content", "highlight"] as const)(
  "repairs a retained rank move across index blocks into %s before publishing a new entrant",
  (band) => {
    const store = new FakeSceneStore();
    for (let rank = 0; rank < 300; rank += 1) {
      const record = fakeRectangleRecord(`ordered-${rank}`, rank, 10 + rank / 1_000, 50);
      store.records.set(record.id, record);
    }
    const viewport = { height: 100, left: 0, top: 0, width: 100 };
    const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
    try {
      scheduler.runAll(200);
      renderer.setViewport({ ...viewport, top: 100_000 });
      scheduler.runAll(200);
      const before = store.records.get("ordered-10")!;
      const moved = { ...before, band, rank: 350 };
      const entrant = fakeRectangleRecord("new-entrant", 250.5, 11, 50);
      store.records.set(moved.id, moved);
      store.records.set(entrant.id, entrant);
      renderer.applyDelta({
        affected: [
          { id: moved.id, domains: ["order"] },
          {
            id: entrant.id,
            before: null,
            after: entrant.element,
            domains: ["geometry", "paint", "order", "visibility"],
          },
        ],
      });
      renderer.setViewport(viewport);
      scheduler.runAll(200);
      for (const current of ["content", "highlight"] as const) {
        const expected = [...store.records.values()]
          .filter((record) => record.band === current)
          .sort((left, right) => left.rank - right.rank);
        expect(renderer.mountedIds(current)).toEqual(expected.map(({ id }) => id));
        const group = fakeNode(renderer.svg).nodes[1]!.nodes[current === "content" ? 4 : 3]!;
        expect(group.nodes.map((node) => node.attributes.get("d"))).toEqual(
          expected.map((record) => buildElementPathParts(record.element)[0]!.d),
        );
      }
    } finally {
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
  },
);
