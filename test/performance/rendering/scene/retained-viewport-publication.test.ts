import { expect, it, vi } from "vitest";

import {
  createSceneFixture,
  createSceneRecord,
  createViewportRectangleStore,
} from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { boundsIntersect, type Bounds } from "../../../../src/domain/geometry/public";
import { SpatialQueryScratch, UniformSpatialIndex } from "../../../../src/domain/spatial";
import type { SceneStorePort, SpatialQuerySink } from "../../../../src/rendering/scene";
import { visibilityPageBounds } from "../../../../src/rendering/scene/scene-resource-policy";
import { removeVisibilityExits } from "../../../../src/rendering/scene/visibility-publication";
import { removeOrderedVisibilityExits } from "../../../../src/rendering/scene/visibility-reconciliation-commit";
import type { PendingReconciliation } from "../../../../src/rendering/scene/reconciliation-state";
import type { MountedSceneElement } from "../../../../src/rendering/scene/mounted-element";
import { arrow } from "../../../unit/domain/schema/fixtures";
import {
  FakeNode,
  FakeSceneStore,
  type FakeScheduler,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

it("returns a connected multipart arrow without publication or order repair", () => {
  const store = new FakeSceneStore();
  const target = { height: 100, left: 0, top: 100, width: 400 };
  const element = { ...arrow(500), start: { x: 200, y: 150 }, end: { x: 300, y: 150 } };
  for (let rank = 0; rank < 256; rank += 1) {
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
  expect(originalNodes).toHaveLength(257);
  const arrowTail = content.nodes[64]!;
  const remove = vi.spyOn(arrowTail, "remove");
  renderer.setViewport({ ...target, top: 1_000 });
  scheduler.runNext();
  expect(remove).not.toHaveBeenCalled();
  expect(arrowTail.parent).toBe(content);
  remove.mockRestore();

  try {
    renderer.resetInstrumentation();
    const writes = collectFrameWrites(content, scheduler, () => renderer.setViewport(target), 20);
    expect(writes.every((count) => count === 0)).toBe(true);
    expect(renderer.instrumentation().domReorders).toBe(0);
    expect(renderer.mountedIds("content")).toEqual([...store.records.keys()]);
    expect(content.nodes).toEqual(originalNodes);
    expect(renderer.instrumentation().detachedCacheBytes).toBeLessThanOrEqual(25 * 1024 * 1024);
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
    expect(writes.every((count) => count <= 192)).toBe(true);
    const expected = [...store.records.values()].filter(
      ({ rank }) => (rank >= 2_000 && rank < 4_000) || rank === 10_000,
    );
    expect(renderer.mountedIds("content")).toEqual(expected.map(({ id }) => id));
    expect(
      content.nodes.map((node) => node.nodes[0]?.attributes.get("d") ?? node.attributes.get("d")),
    ).toEqual(
      [...store.records.values()]
        .filter(({ rank }) => rank < 4_000 || rank === 10_000)
        .map(({ element: ink }) => buildElementPathParts(ink)[0]!.d),
    );
    expect(new Set(content.nodes).size).toBe(content.nodes.length);
    expect(renderer.instrumentation().detachedCacheBytes).toBeLessThanOrEqual(25 * 1024 * 1024);
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

function collectFrameWrites(
  content: FakeNode,
  scheduler: FakeScheduler,
  action: () => void,
  frameLimit: number,
  afterFrame?: (frame: number) => void,
): number[] {
  const original = Object.getOwnPropertyDescriptor(FakeNode.prototype, "insertBefore")!.value as (
    this: FakeNode,
    node: FakeNode,
    reference: FakeNode | null,
  ) => FakeNode;
  const insert = vi.spyOn(content, "insertBefore");
  let roots = 0;
  insert.mockImplementation(function (this: FakeNode, node, reference) {
    roots += node.fragment ? node.nodes.length : 1;
    return original.call(this, node, reference);
  });
  const writes: number[] = [];
  try {
    action();
    while (scheduler.pendingCount > 0) {
      roots = 0;
      scheduler.runNext();
      writes.push(roots);
      expect(writes.length).toBeLessThanOrEqual(frameLimit);
      afterFrame?.(writes.length);
    }
  } finally {
    insert.mockRestore();
  }
  return writes;
}

it("reconciles only changed membership in a 10,000-entry viewport", () => {
  const store = createViewportRectangleStore(10_000, (rank) =>
    rank < 9_000 ? 50 : rank === 9_000 ? -241 : rank === 9_001 ? 351 : 10_000,
  );
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  const get = vi.spyOn(store, "get");
  const query = vi.spyOn(store, "query");
  try {
    scheduler.runAll(200);
    for (const [pass, top] of [100, 0, 100, 0].entries()) {
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
      expect(stats.detachedCacheBytes).toBeLessThanOrEqual(25 * 1024 * 1024);
      expect(stats).toMatchObject({ domEntrants: pass === 0 ? 1 : 0, domExits: 0, domReorders: 0 });
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
    rank < 9_000 ? 50 : rank < 9_400 ? 351 : 10_000,
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
      () => renderer.setViewport({ ...viewport, top: 100 }),
      30,
      (frame) => {
        if (frame === 1) renderer.promoteVisible("entry-9250");
      },
    );
    expect(writes.filter((count) => count > 0).length).toBeGreaterThan(1);
    expect(writes.every((count) => count <= 192)).toBe(true);
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
  const store = createViewportRectangleStore(601, (rank) => (rank < 600 ? 351 : 50));
  const { renderer, scheduler, viewport } = createEdgeViewportScene(store);
  scheduler.runAll(20);
  const now = vi.spyOn(scheduler, "now").mockImplementation(() => (scheduler.time += 0.25));
  try {
    renderer.setViewport({ ...viewport, top: 100 });
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
  const store = createViewportRectangleStore(401, (rank) => (rank < 400 ? 351 : 50));
  const { renderer, scheduler, viewport } = createEdgeViewportScene(store);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  try {
    scheduler.runAll(20);
    renderer.setViewport({ ...viewport, top: 100 });
    scheduler.runNext();
    expect(renderer.mountedCount).toBeGreaterThan(1);
    expect(renderer.mountedCount).toBeLessThan(store.records.size);
    renderer.setViewport(viewport);
    scheduler.runAll(40);
    expect(renderer.mountedIds("content")).toEqual(["entry-400"]);
    expect(content.nodes).toHaveLength(193);
    expect(renderer.instrumentation().detachedCacheEntries).toBe(192);
    renderer.setViewport({ ...viewport, top: 100 });
    scheduler.runAll(40);
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
    rank < 9_000 ? 270 : rank === 9_000 ? -241 : rank === 9_001 ? 521 : 10_000,
  );
  const { store, work } = indexedSceneStore(records);
  const viewport = { height: 271, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  try {
    scheduler.runAll(200);
    work.candidateVisits = 0;
    work.queries = 0;
    renderer.resetInstrumentation();
    renderer.setViewport({ ...viewport, top: 100 });
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
  mounted.set("partial", {
    id: "partial",
    committedRank: count,
    band: "content",
    detachedPathCount: 1,
  } as MountedSceneElement);
  const reverse = [...ids].reverse();
  const pending = {
    exitIds: ["consumed", "partial", ...reverse, "partial", ...reverse],
    exitIndex: 1,
    exitScanComplete: true,
    exitOrderPrepared: false,
  } as PendingReconciliation;
  const get = vi.spyOn(mounted, "get");
  const options = { mounted } as unknown as Parameters<typeof removeVisibilityExits>[1];
  const frame = { deadline: 8, now: () => 8, isExit: () => false };
  expect(removeOrderedVisibilityExits(pending, options, frame)).toBe(false);
  expect(get).not.toHaveBeenCalled();
  expect(pending.exitOrderPrepared).toBe(false);
  expect(pending.exitIds).toEqual(["consumed", "partial", ...reverse, "partial", ...reverse]);
  let clockReads = 0;
  const admitted = { ...frame, now: () => (clockReads++ === 0 ? 0 : 8) };
  expect(removeOrderedVisibilityExits(pending, options, admitted)).toBe(false);
  expect(pending.exitIds).toEqual(["consumed", "partial", ...ids]);
  expect(pending.exitIndex).toBe(1);
  expect(get.mock.calls.length).toBeGreaterThan(count);
  expect(get.mock.calls.length).toBeLessThanOrEqual(count * 32 + 1);
  get.mockClear();
  expect(removeOrderedVisibilityExits(pending, options, frame)).toBe(false);
  expect(get).toHaveBeenCalledExactlyOnceWith("partial");
  expect(pending.exitIndex).toBe(2);
  pending.exitOrderPrepared = false;
  for (let index = 0; index < count; index += 1) {
    pending.exitIds[index + 2] = ids[count - index - 1]!;
  }
  get.mockClear();
  clockReads = 0;
  expect(removeOrderedVisibilityExits(pending, options, admitted)).toBe(false);
  expect(pending.exitIds).toEqual(["consumed", "partial", ...ids]);
  expect(pending.exitIndex).toBe(2);
  expect(get.mock.calls.length).toBeLessThanOrEqual(count * 32 + 1);
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
