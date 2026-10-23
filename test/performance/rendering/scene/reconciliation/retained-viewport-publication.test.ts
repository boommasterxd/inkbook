import { expect, it, vi } from "vitest";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../../src/rendering/scene/constants";

import {
  createSceneFixture,
  createSceneRecord,
  createViewportRectangleStore,
} from "../../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../../fixtures/rendering/pressure-navigation";
import {
  collectFrameWrites,
  createDirectPublicationScene,
} from "../../../../fixtures/rendering/scene-publication";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { boundsIntersect, type Bounds } from "../../../../../src/domain/geometry/public";
import { SpatialQueryScratch, UniformSpatialIndex } from "../../../../../src/domain/spatial";
import type { SceneStorePort, SpatialQuerySink } from "../../../../../src/rendering/scene";
import { visibilityPageBounds } from "../../../../../src/rendering/scene/scene-resource-policy";
import { removeVisibilityExits } from "../../../../../src/rendering/scene/reconciliation/visibility-publication";
import { removeOrderedVisibilityExits } from "../../../../../src/rendering/scene/reconciliation/visibility-reconciliation-commit";
import type { PendingReconciliation } from "../../../../../src/rendering/scene/reconciliation/reconciliation-state";
import type { MountedSceneElement } from "../../../../../src/rendering/scene/content/mounted-element";
import { arrow } from "../../../../unit/domain/schema/fixtures";
import {
  FakeSceneStore,
  fakeNode,
  fakeRectangleRecord,
} from "../../../../unit/rendering/scene/fakes";

it("reuses detached multipart arrow roots with bounded publication and no order repair", () => {
  const store = new FakeSceneStore();
  const target = { height: 100, left: 0, top: 120, width: 400 };
  const element = { ...arrow(500), start: { x: 200, y: 150 }, end: { x: 300, y: 150 } };
  const count = SCENE_PUBLICATION_ROOTS_PER_FRAME + 64;
  for (let rank = 0; rank < count; rank += 1) {
    const record =
      rank === 63
        ? createSceneRecord(element, rank)
        : fakeRectangleRecord(`retained-${rank}`, rank, 20, 150);
    store.records.set(record.id, record);
  }
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, target);
  scheduler.runAll(20);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  const originalNodes = [...content.nodes];
  expect(originalNodes).toHaveLength(count + 1);
  const arrowTail = content.nodes[64]!;
  renderer.setViewport({ ...target, top: 1_000 });
  collectFrameWrites(content, scheduler, () => undefined, 20);
  expect(arrowTail.parentNode).toBeNull();
  expect(originalNodes.every((node) => node.parentNode === null)).toBe(true);
  expect(content.nodes).toHaveLength(0);

  try {
    renderer.resetInstrumentation();
    const writes = collectFrameWrites(content, scheduler, () => renderer.setViewport(target), 20);
    expect(writes.reduce((total, count) => total + count, 0)).toBe(count + 1);
    expect(writes.filter((count) => count > 0).length).toBeGreaterThan(1);
    expect(writes.every((count) => count <= SCENE_PUBLICATION_ROOTS_PER_FRAME)).toBe(true);
    expect(renderer.instrumentation().geometryBuilds).toBe(0);
    expect(renderer.instrumentation().domReorders).toBe(0);
    expect(renderer.mountedIds("content")).toEqual([...store.records.keys()]);
    expect(content.nodes).toEqual(originalNodes);
    expect(renderer.instrumentation().detachedCacheBytes).toBeLessThanOrEqual(1024 * 1024);
  } finally {
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("bounds a single new stroke while page growth reveals a dense 10,000-entry document", () => {
  const store = createViewportRectangleStore(10_000, (rank) =>
    rank < 2_000 ? 10 : rank < 4_000 ? 1_000 : 10_000,
  );
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  scheduler.runAll(100);
  const element = {
    ...indexedStroke(10_001),
    pivot: { x: 25, y: 1_010 },
    points: [20, 1_010, 0.5, 30, 1_010, 0.5],
  };
  const newRecord = createSceneRecord(element, 10_000);
  store.records.set(newRecord.id, newRecord);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  try {
    const writes = collectFrameWrites(
      content,
      scheduler,
      () => {
        renderer.setPage(NAVIGATION_PAGE, 2_000);
        renderer.setViewport({ ...viewport, top: 1_000 });
        renderer.applyDelta({
          affected: [
            {
              before: null,
              after: element,
              domains: ["geometry", "paint", "order", "visibility"],
              id: element.id,
            },
          ],
        });
      },
      100,
    );
    expect(writes.some((count) => count > 0)).toBe(true);
    expect(writes.every((count) => count <= SCENE_PUBLICATION_ROOTS_PER_FRAME)).toBe(true);
    const expected = [...store.records.values()].filter(
      ({ rank }) => (rank >= 2_000 && rank < 4_000) || rank === 10_000,
    );
    expect(renderer.mountedIds("content")).toEqual(expected.map(({ id }) => id));
    expect(
      content.nodes.map((node) => node.nodes[0]?.attributes.get("d") ?? node.attributes.get("d")),
    ).toEqual(expected.map(({ element: ink }) => buildElementPathParts(ink)[0]!.d));
    expect(new Set(content.nodes).size).toBe(content.nodes.length);
    expect(renderer.instrumentation().detachedCacheBytes).toBeLessThanOrEqual(1024 * 1024);
  } finally {
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("keeps the completed reorder proof across later full reconciliations", () => {
  const store = createViewportRectangleStore(256, () => 20);
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  scheduler.runAll(20);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  const first = store.records.get("entry-0")!;
  store.records.set(first.id, { ...first, rank: 256 });
  renderer.applyDelta({ affected: [{ id: first.id, domains: ["order"] }] });
  scheduler.runAll(20);
  expect(renderer.instrumentation().domReorders).toBeGreaterThan(0);
  expect(renderer.mountedIds("content")[255]).toBe(first.id);

  const childNodes = vi.spyOn(content, "childNodes", "get");
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      renderer.applyDelta({ affected: [{ id: first.id, domains: ["order"] }] });
      scheduler.runAll(20);
      expect(childNodes).not.toHaveBeenCalled();
      expect(renderer.mountedIds("content")[255]).toBe(first.id);
    }
  } finally {
    childNodes.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("reconciles only changed membership in a 10,000-entry viewport", () => {
  const store = createViewportRectangleStore(10_000, (rank) =>
    rank < 9_000 ? 50 : rank === 9_000 ? -301 : rank === 9_001 ? 411 : 10_000,
  );
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  const get = vi.spyOn(store, "get");
  const query = vi.spyOn(store, "query");
  try {
    scheduler.runAll(200);
    for (const top of [120, 0, 120, 0]) {
      renderer.resetInstrumentation();
      get.mockClear();
      query.mockClear();
      renderer.setViewport({ ...viewport, top });
      scheduler.runAll(20);
      const bounds = visibilityPageBounds({ ...viewport, top }, { x: 0, zoom: 1 }).envelope;
      const expected = [...store.records.values()]
        .filter((record) => boundsIntersect(bounds, record.bounds))
        .map((record) => record.id);
      const stats = renderer.instrumentation();
      expect(renderer.mountedIds("content")).toEqual(expected);
      expect(renderer.mountedCount).toBe(expected.length);
      const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
      expect(new Set(content.nodes).size).toBe(content.nodes.length);
      expect(content.nodes).toHaveLength(expected.length);
      expect(stats.detachedCacheBytes).toBeLessThanOrEqual(1024 * 1024);
      expect(stats).toMatchObject({ domEntrants: 1, domExits: 1, domReorders: 0 });
      expect(stats.visibilityCandidateVisits).toBeLessThanOrEqual(4);
      expect(stats.visibilityReconcileVisits).toBeLessThanOrEqual(24);
      expect(query.mock.calls.length).toBeGreaterThan(0);
      expect(query.mock.calls.length).toBeLessThanOrEqual(4);
      expect(get.mock.calls.length).toBeLessThanOrEqual(40);
    }
  } finally {
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("publishes a 400-entry edge delta in bounded frames within a 10,000-entry document", () => {
  const records = createViewportRectangleStore(10_000, (rank) =>
    rank < 9_000 ? 50 : rank < 9_400 ? 411 : 10_000,
  );
  const { store, work } = indexedSceneStore(records);
  const { renderer, scheduler, viewport } = createEdgeViewportScene(store);
  const get = vi.spyOn(store, "get");
  scheduler.runAll(200);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  work.candidateVisits = 0;
  renderer.resetInstrumentation();
  get.mockClear();
  try {
    const writes = collectFrameWrites(
      content,
      scheduler,
      () => renderer.setViewport({ ...viewport, top: 120 }),
      30,
      (frame) => {
        if (frame === 1) renderer.promoteVisible("entry-9250");
      },
    );
    expect(writes.filter((count) => count > 0).length).toBeGreaterThan(1);
    expect(writes.every((count) => count <= SCENE_PUBLICATION_ROOTS_PER_FRAME)).toBe(true);
    expect(renderer.mountedIds("content")).toEqual(
      Array.from({ length: 9_400 }, (_, index) => `entry-${index}`),
    );
    expect(renderer.instrumentation()).toMatchObject({ domEntrants: 400, domReorders: 0 });
    expect(renderer.instrumentation().visibilityCandidateVisits).toBeLessThanOrEqual(10_000);
    expect(renderer.instrumentation().visibilityReconcileVisits).toBeLessThanOrEqual(10_000);
    expect(work.candidateVisits).toBeLessThanOrEqual(20_000);
    expect(get.mock.calls.length).toBeLessThanOrEqual(35_000);
  } finally {
    get.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("resumes a long delta successor search at the shared frame deadline", () => {
  const store = createViewportRectangleStore(601, (rank) => (rank < 600 ? 411 : 50));
  const { renderer, scheduler, viewport } = createEdgeViewportScene(store);
  scheduler.runAll(20);
  const now = vi.spyOn(scheduler, "now").mockImplementation(() => (scheduler.time += 0.25));
  try {
    renderer.setViewport({ ...viewport, top: 120 });
    let frames = 0;
    while (scheduler.pendingCount > 0) {
      renderer.resetInstrumentation();
      scheduler.runNext();
      expect(renderer.instrumentation().visibilityReconcileVisits).toBeLessThanOrEqual(256);
      expect(++frames).toBeLessThanOrEqual(400);
    }
    expect(frames).toBeGreaterThan(10);
    expect(renderer.mountedIds("content")).toEqual(
      Array.from({ length: 601 }, (_, index) => `entry-${index}`),
    );
  } finally {
    now.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("cancels a partially published large edge delta on viewport retarget", () => {
  const store = createViewportRectangleStore(401, (rank) => (rank < 400 ? 411 : 50));
  const { renderer, scheduler, viewport } = createEdgeViewportScene(store);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  try {
    scheduler.runAll(20);
    const stable = content.nodes[0]!;
    renderer.setViewport({ ...viewport, top: 120 });
    scheduler.runNext();
    expect(renderer.mountedCount).toBeGreaterThan(1);
    expect(renderer.mountedCount).toBeLessThan(store.records.size);
    const partial = content.nodes.filter((node) => node !== stable);
    collectFrameWrites(content, scheduler, () => renderer.setViewport(viewport), 40);
    expect(renderer.mountedIds("content")).toEqual(["entry-400"]);
    expect(content.nodes).toHaveLength(1);
    expect(partial.every((node) => node.parentNode === null)).toBe(true);
    expect(renderer.instrumentation().detachedCacheEntries).toBe(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    const writes = collectFrameWrites(
      content,
      scheduler,
      () => renderer.setViewport({ ...viewport, top: 120 }),
      40,
    );
    expect(writes.every((count) => count <= SCENE_PUBLICATION_ROOTS_PER_FRAME)).toBe(true);
    expect(partial.every((node) => content.nodes.includes(node))).toBe(true);
    expect(renderer.mountedIds("content")).toEqual(
      Array.from({ length: 401 }, (_, index) => `entry-${index}`),
    );
  } finally {
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("counts real index cell visits when a narrow fringe shares a dense spatial cell", () => {
  const records = createViewportRectangleStore(10_000, (rank) =>
    rank < 9_000 ? 530 : rank === 9_000 ? -301 : rank === 9_001 ? 581 : 10_000,
  );
  const { store, work } = indexedSceneStore(records);
  const viewport = { height: 271, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  try {
    scheduler.runAll(200);
    work.candidateVisits = 0;
    work.queries = 0;
    renderer.resetInstrumentation();
    renderer.setViewport({ ...viewport, top: 120 });
    scheduler.runAll(20);
    expect(renderer.mountedCount).toBe(9_001);
    expect(renderer.instrumentation().visibilityCandidateVisits).toBe(2);
    expect(work.queries).toBeGreaterThan(0);
    expect(work.queries).toBeLessThanOrEqual(4);
    expect(work.candidateVisits).toBeGreaterThanOrEqual(9_000);
    expect(work.candidateVisits).toBeLessThanOrEqual(records.records.size * 4);
  } finally {
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

function createEdgeViewportScene(store: SceneStorePort) {
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  return { ...createSceneFixture(NAVIGATION_PAGE, store, viewport), viewport };
}

it("limits real index cell visits when a wide viewport pans over distributed elements", () => {
  const records = new FakeSceneStore();
  for (let rank = 0; rank < 1_000; rank += 1) {
    const record = fakeRectangleRecord(`spread-${rank}`, rank, rank * 30, 50);
    records.records.set(record.id, record);
  }
  const { store, work } = indexedSceneStore(records);
  const viewport = { height: 100, left: 0, top: 0, width: 30_000 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  try {
    scheduler.runAll(30);
    work.candidateVisits = 0;
    work.queries = 0;
    renderer.resetInstrumentation();
    renderer.setCamera({ x: -50, zoom: 1 });
    scheduler.runAll(20);
    expect(renderer.mountedCount).toBe(records.records.size);
    expect(work.queries).toBeGreaterThan(0);
    expect(work.queries).toBeLessThanOrEqual(4);
    expect(work.candidateVisits).toBeLessThanOrEqual(64);
    expect(renderer.instrumentation().visibilityCandidateVisits).toBeLessThanOrEqual(8);
  } finally {
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

function indexedSceneStore(records: FakeSceneStore): {
  readonly store: SceneStorePort;
  readonly work: { candidateVisits: number; queries: number };
} {
  const index = new UniformSpatialIndex<string>();
  index.insertMany([...records.records.values()].map(({ bounds, id }) => ({ bounds, id })));
  const scratch = new SpatialQueryScratch<string>();
  const work = { candidateVisits: 0, queries: 0 };
  const store: SceneStorePort = {
    get: (id) => records.get(id),
    query: (bounds: Bounds, sink: SpatialQuerySink) => {
      work.queries += 1;
      index.query(bounds, scratch);
      work.candidateVisits += scratch.candidateVisitCount;
      for (let cursor = 0; cursor < scratch.count; cursor += 1) sink.add(scratch.at(cursor));
    },
  };
  return { store, work };
}

it("scans exit candidates until the shared deadline instead of a fixed visit quota", () => {
  const ids = Array.from({ length: 10_000 }, (_, index) => `candidate-${index}`);
  const pending = { exitIds: ids, exitIndex: 0 };
  const mounted = new Map<string, never>();
  const get = vi.spyOn(mounted, "get");
  const options = { mounted } as unknown as Parameters<typeof removeVisibilityExits>[1];
  let clockReads = 0;
  expect(
    removeVisibilityExits(pending, options, {
      deadline: 8,
      now: () => ++clockReads,
      isExit: () => false,
    }),
  ).toBe(false);
  expect(pending.exitIndex).toBeGreaterThan(0);
  expect(pending.exitIndex).toBeLessThan(ids.length);
  expect(get.mock.calls.length).toBe(pending.exitIndex);
  expect(
    removeVisibilityExits(pending, options, {
      deadline: 8,
      now: () => 0,
      isExit: () => false,
    }),
  ).toBe(true);
  expect(pending.exitIndex).toBe(ids.length);
  expect(get).toHaveBeenCalledTimes(ids.length);
});

it("orders the document-capacity cleanup once while keeping its partial cursor", () => {
  const count = 20_000;
  const fixture = createDirectPublicationScene("multipart");
  const partial = fixture.entry;
  partial.committedRank = count;
  partial.detachedPathCount = 1;
  fixture.content.insertBefore(
    fakeNode(partial.paths[0]!.node),
    fakeNode(fixture.after.paths[0]!.node),
  );
  const ids = Array.from({ length: count }, (_, rank) => `exit-${rank}`);
  const mounted = new Map<string, MountedSceneElement>();
  for (let rank = 0; rank < count; rank += 1) {
    mounted.set(ids[rank]!, {
      id: ids[rank]!,
      committedRank: rank,
      band: rank < count / 2 ? "highlight" : "content",
      detachedPathCount: 0,
    } as MountedSceneElement);
  }
  mounted.set(partial.id, partial);
  const reverse = [...ids].reverse();
  const pending = {
    exitIds: ["consumed", partial.id, ...reverse, partial.id, ...reverse],
    exitIndex: 1,
    exitScanComplete: true,
    exitOrderPrepared: false,
  } as PendingReconciliation;
  const get = vi.spyOn(mounted, "get");
  const options = { ...fixture, mounted } as unknown as Parameters<typeof removeVisibilityExits>[1];
  const publication = { remainingRoots: partial.paths.length, remainingRemovals: 64 };
  const frame = { deadline: 8, now: () => 8, isExit: () => false, publication };
  expect(removeOrderedVisibilityExits(pending, options, frame)).toBe(false);
  expect(get).not.toHaveBeenCalled();
  expect(pending.exitOrderPrepared).toBe(false);
  expect(pending.exitIds).toEqual(["consumed", partial.id, ...reverse, partial.id, ...reverse]);
  let clockReads = 0;
  const admitted = { ...frame, now: () => (clockReads++ === 0 ? 0 : 8) };
  expect(removeOrderedVisibilityExits(pending, options, admitted)).toBe(false);
  expect(pending.exitIds).toEqual(["consumed", partial.id, ...ids]);
  expect(pending.exitIndex).toBe(1);
  expect(get.mock.calls.length).toBeGreaterThan(count);
  expect(get.mock.calls.length).toBeLessThanOrEqual(count * 32 + 1);
  get.mockClear();
  expect(removeOrderedVisibilityExits(pending, options, frame)).toBe(false);
  expect(get).toHaveBeenCalledExactlyOnceWith(partial.id);
  expect(partial.detachedPathCount).toBe(0);
  expect(partial.paths.every(({ node }) => node.parentNode === fixture.dom.contentGroup)).toBe(
    true,
  );
  expect(fixture.instrumentation.domRootsPublished).toBe(partial.paths.length);
  expect(publication.remainingRoots).toBe(0);
  expect(pending.exitIndex).toBe(2);
  pending.exitOrderPrepared = false;
  for (let index = 0; index < count; index += 1) {
    pending.exitIds[index + 2] = ids[count - index - 1]!;
  }
  get.mockClear();
  clockReads = 0;
  expect(removeOrderedVisibilityExits(pending, options, admitted)).toBe(false);
  expect(pending.exitIds).toEqual(["consumed", partial.id, ...ids]);
  expect(pending.exitIndex).toBe(2);
  expect(get.mock.calls.length).toBeLessThanOrEqual(count * 32 + 1);
  fixture.dom.release();
});

it("checks the deadline while a full fallback visits stable mounted elements", () => {
  const store = new FakeSceneStore();
  for (let rank = 0; rank < 300; rank += 1) {
    const record = fakeRectangleRecord(`stable-${rank}`, rank, 20, 10);
    store.records.set(record.id, record);
  }
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store);
  scheduler.runAll(20);
  const now = vi.spyOn(scheduler, "now").mockImplementation(() => scheduler.time++);
  renderer.clearProgressiveElementPreviews();
  let frames = 0;
  try {
    while (scheduler.pendingCount > 0) {
      expect(++frames).toBeLessThanOrEqual(1_000);
      renderer.resetInstrumentation();
      scheduler.runNext();
      expect(renderer.instrumentation().visibilityReconcileVisits).toBeLessThanOrEqual(16);
    }
    expect(renderer.mountedCount).toBe(300);
  } finally {
    now.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});
