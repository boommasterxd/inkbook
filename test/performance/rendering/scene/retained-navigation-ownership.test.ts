import { expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { SpatialQueryScratch, UniformSpatialIndex } from "../../../../src/domain/spatial";
import type { SceneStorePort } from "../../../../src/rendering/scene/types";
import {
  DETACHED_ELEMENT_CACHE_MAX_BYTES,
  SCENE_PUBLICATION_ROOTS_PER_FRAME,
} from "../../../../src/rendering/scene/constants";
import { DetachedSceneElementCache } from "../../../../src/rendering/scene/detached-element-cache";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { createMountedElement } from "../../../../src/rendering/scene/mounted-element";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import {
  createSceneFixture,
  createSceneRecord,
  createViewportRectangleStore,
  createIndexedSceneStore,
} from "../../../fixtures/rendering/scene";
import {
  asDocument,
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

it.each([false, true])(
  "retains published cleanup across repeated indexed delta targets with return=%s",
  (returns) => {
    const records = createViewportRectangleStore(10_000, (rank) =>
      rank < 300 ? 50 : rank === 300 ? 1_200 : rank === 301 ? 2_200 : 20_000,
    );
    const { store, work, fallback } = createIndexedSceneStore(records);
    const viewport = { height: 100, left: 0, top: 0, width: 100 };
    const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
    scheduler.runAll();
    const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
    const original = [...content.nodes];
    const scans = vi.spyOn(records.records, "values");
    const removal = vi.spyOn(FakeNode.prototype, "remove");
    renderer.resetInstrumentation();
    work.indexedVisits = 0;
    const frame = () => {
      const roots = renderer.instrumentation().domRootsPublished;
      removal.mockClear();
      scheduler.runNext();
      expect(removal.mock.calls.length).toBeLessThanOrEqual(64);
      expect(renderer.instrumentation().domRootsPublished - roots).toBeLessThanOrEqual(
        SCENE_PUBLICATION_ROOTS_PER_FRAME,
      );
    };
    try {
      renderer.setViewport({ ...viewport, top: 1_000 });
      frame();
      expect(renderer.mountedIds("content")).toEqual(["entry-300"]);
      expect(renderer.mountedCount).toBe(237);
      expect(removal).toHaveBeenCalledTimes(64);
      for (const top of [2_000, 1_000, 2_000]) {
        renderer.setViewport({ ...viewport, top });
        frame();
      }
      expect(renderer.instrumentation().visibilityReconcileVisits).toBeLessThanOrEqual(24);
      if (returns) renderer.setViewport(viewport);
      let frames = 0;
      while (scheduler.pendingCount > 0) {
        frame();
        expect(++frames).toBeLessThanOrEqual(20);
      }
      expect(renderer.mountedCount).toBe(returns ? 300 : 1);
      expect(content.nodes).toHaveLength(renderer.mountedCount);
      expect(renderer.mountedIds("content")).toEqual(
        returns ? Array.from({ length: 300 }, (_, rank) => `entry-${rank}`) : ["entry-301"],
      );
      if (returns) expect(content.nodes).toEqual(original);
      else expect(original.every((node) => node.parent === undefined)).toBe(true);
      expect(work.indexedVisits).toBeLessThanOrEqual(1_000);
      expect(fallback).not.toHaveBeenCalled();
      expect(scans).not.toHaveBeenCalled();
      expect(renderer.hasPendingSceneCommit).toBe(false);
    } finally {
      removal.mockRestore();
      scans.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
    expect(renderer.memoryUsage()).toMatchObject({ pathCacheBytes: 0, motionCacheBytes: 0 });
    expect(renderer.instrumentation().detachedCacheEntries).toBe(0);
  },
);

it("mounts nearby offscreen strokes before scrolling into them and reuses their original roots", () => {
  const records = new FakeSceneStore();
  const base = createTestStroke();
  for (let rank = 0; rank < 10_000; rank += 1) {
    const y = rank < 500 ? 850 : rank < 1_000 ? 1_250 : 10_000;
    const id = `00000000-0000-4000-8000-${String(rank).padStart(12, "0")}`;
    const element = { ...base, id, pivot: { x: 20, y }, points: [20, y, 0.5, 21, y, 1] };
    records.records.set(id, createSceneRecord(element, rank));
  }
  const index = new UniformSpatialIndex<string>();
  index.insertMany([...records.records.values()].map(({ id, bounds }) => ({ id, bounds })));
  const scratch = new SpatialQueryScratch<string>();
  let indexedVisits = 0;
  const store: SceneStorePort = {
    get: (id) => records.get(id),
    query: (bounds, sink) => {
      index.query(bounds, scratch);
      indexedVisits += scratch.candidateVisitCount;
      for (let position = 0; position < scratch.count; position += 1)
        sink.add(scratch.at(position));
    },
  };
  const viewport = { height: 100, left: 0, top: 1_000, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  try {
    let frames = 0;
    while (scheduler.pendingCount > 0) {
      renderer.resetInstrumentation();
      scheduler.runNext();
      expect(renderer.instrumentation().domRootsPublished).toBeLessThanOrEqual(
        SCENE_PUBLICATION_ROOTS_PER_FRAME,
      );
      expect(++frames).toBeLessThanOrEqual(20);
    }
    expect(renderer.mountedCount).toBe(1_000);
    const original = [...content.nodes];
    const originalSet = new Set(original);
    expect(original).toHaveLength(1_000);
    const insert = vi.spyOn(content, "insertBefore");
    for (const top of [1_180, 800, 1_000]) {
      renderer.resetInstrumentation();
      renderer.setViewport({ ...viewport, top });
      scheduler.runAll(20);
      expect(renderer.instrumentation().geometryBuilds).toBe(0);
      expect(content.nodes).toHaveLength(renderer.mountedCount);
      expect(content.nodes.every((node) => originalSet.has(node))).toBe(true);
    }
    expect(indexedVisits).toBeLessThanOrEqual(4_000);
    expect(insert).toHaveBeenCalled();
    expect(renderer.instrumentation().detachedCacheBytes).toBeLessThanOrEqual(
      DETACHED_ELEMENT_CACHE_MAX_BYTES,
    );
    renderer.setViewport({ ...viewport, top: 10_000 });
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
    expect(renderer.memoryUsage().pathCacheBytes).toBe(0);
    expect(fakeNode(renderer.svg).parent).toBeUndefined();
  } finally {
    renderer.destroy();
  }
});

it("honors an explicit larger byte limit without an independent count eviction", () => {
  const maximumBytes = 25 * 1_024 * 1_024;
  const cache = new DetachedSceneElementCache(maximumBytes);
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
    expect(cache.statistics().bytes).toBeLessThan(maximumBytes);
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

it("keeps only the current envelope connected across 10,000 contour-warm visits", () => {
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
  const remove = vi.spyOn(FakeNode.prototype, "remove");
  const create = vi.spyOn(content.ownerDocument, "createElementNS");
  const insert = vi.spyOn(content, "insertBefore");
  try {
    for (const top of [0, 1_000, 100_000, 0, 1_000]) {
      renderer.resetInstrumentation();
      renderer.setViewport({ ...viewport, top });
      let frames = 0;
      while (scheduler.pendingCount > 0) {
        remove.mockClear();
        renderer.resetInstrumentation();
        scheduler.runNext();
        expect(remove.mock.calls.length).toBeLessThanOrEqual(64);
        expect(renderer.instrumentation().domRootsPublished).toBeLessThanOrEqual(
          SCENE_PUBLICATION_ROOTS_PER_FRAME,
        );
        expect(renderer.instrumentation().geometryBuilds).toBe(0);
        expect(++frames).toBeLessThanOrEqual(200);
      }
      expect(renderer.mountedCount).toBe(top === 100_000 ? 0 : 5_000);
      expect(content.nodes).toHaveLength(renderer.mountedCount);
      expect(renderer.instrumentation().detachedCacheEntries).toBeLessThan(1_000);
      expect(renderer.instrumentation().detachedCacheBytes).toBeLessThan(
        DETACHED_ELEMENT_CACHE_MAX_BYTES,
      );
    }
    expect(create.mock.calls.filter(([, tag]) => tag === "path").length).toBeGreaterThan(0);
    expect(create.mock.calls.filter(([, tag]) => tag === "path").length).toBeLessThanOrEqual(
      20_000,
    );
    expect(insert).toHaveBeenCalled();
  } finally {
    remove.mockRestore();
    create.mockRestore();
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
