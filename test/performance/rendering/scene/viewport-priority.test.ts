import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { SceneEntrantPriority } from "../../../../src/rendering/scene/scene-entrant-priority";
import { MountSlice } from "../../../../src/rendering/scene/mount-slice";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import {
  createPendingScenePathStore,
  createSceneFixture,
  createSceneRecord,
} from "../../../fixtures/rendering/scene";
import {
  beginViewportPublication,
  chargeClockAfterPublication,
  flushBoundedScenePublication,
} from "../../../fixtures/rendering/scene-publication";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import {
  FakeNode,
  FakeSceneStore,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

it("publishes the actual viewport before highlight overscan within a 10,000-element index", () => {
  const elements = Array.from({ length: 10_000 }, (_, rank) => {
    if (rank < 64) {
      const stroke = indexedStroke(rank);
      return {
        ...stroke,
        tool: "highlighter" as const,
        pivot: { x: 20, y: 140 },
        points: [20, 140, 0.5, 30 + rank / 10, 140, 0.5],
        style: { ...stroke.style, pressureEnabled: false },
      };
    }
    return fakeRectangleRecord(
      indexedStroke(rank).id,
      rank,
      20,
      rank < 192 ? 30 + rank / 10 : 10_000,
    ).element;
  });
  const domain = new ElementStore(elements);
  const scene = new ElementSceneStore(domain);
  const queryOriginal = domain.beginQuery.bind(domain);
  let indexedVisits = 0;
  const query = vi.spyOn(domain, "beginQuery").mockImplementation((bounds) => {
    const cursor = queryOriginal(bounds);
    const advance = cursor.advance.bind(cursor);
    vi.spyOn(cursor, "advance").mockImplementation((limit) => {
      const step = advance(limit);
      indexedVisits += step.workUnits;
      return step;
    });
    return cursor;
  });
  const get = vi.spyOn(scene, "get");
  const { renderer, scheduler, document } = createSceneFixture(NAVIGATION_PAGE, scene, {
    height: 100,
    left: 0,
    top: 0,
    width: 100,
  });
  renderer.setReducedMotion(true);
  const create = vi.spyOn(document, "createElementNS");
  try {
    scheduler.runNext();
    expect(renderer.mountedCount).toBe(64);
    expect(renderer.mountedIds("highlight")).toEqual([]);
    expect(renderer.mountedIds("content")).toHaveLength(64);
    flushBoundedScenePublication(renderer, scheduler);
    expect(renderer.mountedCount).toBe(192);
    expect(renderer.mountedIds("highlight")).toHaveLength(64);
    expect(renderer.mountedIds("content")).toHaveLength(128);
    expect(create.mock.calls.filter(([, tag]) => tag === "path")).toHaveLength(192);
    expect(indexedVisits).toBeLessThanOrEqual(384);
    expect(query).toHaveBeenCalledOnce();
    expect(get.mock.calls.length).toBeLessThanOrEqual(1_152);
    expect(renderer.instrumentation().visibilityReconcileVisits).toBeLessThanOrEqual(1_152);
  } finally {
    renderer.destroy();
    scene.release();
    query.mockRestore();
    get.mockRestore();
    create.mockRestore();
  }
  expect(renderer.mountedCount).toBe(0);
  expect(scheduler.pendingCount).toBe(0);
});

it("keeps bounded protocol lookahead ordered without consuming a 10,000-candidate heap", () => {
  const store = new FakeSceneStore();
  const ids = Array.from(
    { length: 10_000 },
    (_, rank) => `lookahead-${String(rank).padStart(5, "0")}`,
  );
  ids.forEach((id, rank) => store.records.set(id, fakeRectangleRecord(id, rank, 20, rank)));
  const stats = createInstrumentation();
  const priority = new SceneEntrantPriority(ids.values(), store, new Set(), stats, {
    viewport: { minX: 0, maxX: 100, minY: 0, maxY: 100 },
    direction: { x: 0, y: 1 },
  });
  const get = vi.spyOn(store, "get");
  expect(priority.build(new MountSlice(Infinity, () => 0))).toBeUndefined();
  expect(get).toHaveBeenCalledTimes(10_000);
  const preparedReads = get.mock.calls.length;
  expect([...priority.upcoming(0)]).toEqual([]);
  const preview = [...priority.upcoming(256)];
  expect(preview).toEqual(ids.slice(0, 256));
  expect(priority.count).toBe(10_000);
  expect([...priority.upcoming(256)]).toEqual(preview);
  expect(get).toHaveBeenCalledTimes(preparedReads);
  expect(Array.from({ length: 256 }, () => priority.take())).toEqual(preview);
  expect(priority.count).toBe(9_744);
  expect(priority.memoryUsage()).toBeLessThanOrEqual(10_000 * 72);
  for (const id of preview) priority.release(id);
  let previous: string[] = [];
  for (let revision = 0; revision < 2_000; revision += 1) {
    const id = `retarget-${revision}`;
    store.records.set(id, fakeRectangleRecord(id, 10_000 + revision, 20, 20));
    const entered = [id];
    priority.retarget(entered, previous, undefined);
    previous = [id];
    // The query owns and reuses its buffer immediately after handing it off.
    entered.length = 0;
    expect(priority.count).toBe(0);
    expect(priority.memoryUsage()).toBeLessThanOrEqual(9_745 * 32);
  }
  get.mockClear();
  expect(priority.build(new MountSlice(Infinity, () => 0))).toBeUndefined();
  expect(get).toHaveBeenCalledTimes(9_745);
  const remaining = [...priority.upcoming(priority.count)];
  expect(new Set(remaining).size).toBe(9_745);
  expect(remaining).toContain("retarget-1999");
  expect(remaining.some((id) => id === "retarget-0")).toBe(false);
  expect(priority.memoryUsage()).toBeLessThanOrEqual(9_745 * 72);
  get.mockRestore();
});

it("finishes logical exits without detaching cached roots behind new publication", () => {
  const store = new FakeSceneStore();
  for (let rank = 0; rank < 768; rank += 1) {
    const id = `cleanup-${rank}`;
    store.records.set(id, fakeRectangleRecord(id, rank, 20, rank < 256 ? 20 : 1_020));
  }
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  renderer.setReducedMotion(true);
  scheduler.runAll();
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  const oldNodes = new Set(content.nodes);
  let oldRemovals = 0;
  const originalRemove = Object.getOwnPropertyDescriptor(FakeNode.prototype, "remove")!.value as (
    this: FakeNode,
  ) => void;
  const remove = vi.spyOn(FakeNode.prototype, "remove").mockImplementation(function (
    this: FakeNode,
  ) {
    if (oldNodes.has(this)) oldRemovals += 1;
    originalRemove.call(this);
  });
  const restoreClock = chargeClockAfterPublication(content, scheduler);
  try {
    const first = beginViewportPublication(renderer, scheduler, { ...viewport, top: 1_000 });
    expect(first.domEntrants).toBe(64);
    expect(oldRemovals).toBe(0);
    let frames = 0;
    while (renderer.instrumentation().detachedCacheEntries === 0 && frames < 100) {
      const before = oldRemovals;
      scheduler.runNext();
      expect(oldRemovals - before).toBeLessThanOrEqual(1);
      frames += 1;
    }
    expect(
      renderer.instrumentation().detachedCacheEntries,
      JSON.stringify({
        ...renderer.instrumentation(),
        mountedCount: renderer.mountedCount,
        pendingCount: scheduler.pendingCount,
      }),
    ).toBeGreaterThan(0);
    expect(oldRemovals).toBe(0);
    expect(renderer.instrumentation().domExits).toBe(oldRemovals);
    expect(renderer.instrumentation().domEntrants).toBeLessThanOrEqual(66);
    expect([...oldNodes].filter((node) => node.parent === content)).toHaveLength(256);
    restoreClock();
    remove.mockRestore();
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(512);
    expect(renderer.mountedIds("content")).toEqual(
      Array.from({ length: 512 }, (_, rank) => `cleanup-${rank + 256}`),
    );
    expect(renderer.instrumentation().domExits).toBe(0);
    expect(renderer.instrumentation().detachedCacheEntries).toBe(256);
    expect(content.nodes).toHaveLength(768);
    expect(new Set(content.nodes).size).toBe(768);
    expect(renderer.instrumentation().detachedCacheBytes).toBeLessThanOrEqual(25 * 1024 * 1024);
  } finally {
    restoreClock();
    remove.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("finishes partially scanned old mounts while remote geometry waits, then stops scene polling", () => {
  const { store, signals } = createPendingScenePathStore();
  for (let rank = 0; rank < 128; rank += 1) {
    const id = `old-${rank}`;
    store.records.set(id, fakeRectangleRecord(id, rank, 20, 20));
  }
  store.records.set("warm", fakeRectangleRecord("warm", 128, 20, 1_010));
  const cold = {
    ...indexedStroke(33),
    pivot: { x: 20, y: 1_020 },
    points: [20, 1_020, 0.5, 30, 1_020, 0.5],
  };
  store.records.set(cold.id, createSceneRecord(cold, 129));
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  renderer.setReducedMotion(true);
  scheduler.runNext();
  expect(renderer.mountedCount).toBe(64);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  const oldNodes = [...content.nodes];
  const restoreClock = chargeClockAfterPublication(content, scheduler);
  try {
    const first = beginViewportPublication(renderer, scheduler, { ...viewport, top: 1_000 });
    expect(first.domEntrants).toBe(1);
    expect(oldNodes.every((node) => node.parent === content)).toBe(true);
    scheduler.runAll(300);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    expect(renderer.mountedIds("content")).toEqual(["warm"]);
    expect(oldNodes.every((node) => node.parent === content)).toBe(true);
    expect(renderer.instrumentation().domExits).toBe(0);
    expect(renderer.instrumentation().detachedCacheEntries).toBe(64);
    expect(content.nodes).toHaveLength(65);
    expect(new Set(content.nodes).size).toBe(65);
    expect(renderer.instrumentation().visibilityReconcileVisits).toBeLessThanOrEqual(
      oldNodes.length * 3 + 16,
    );
    expect(scheduler.pendingCount).toBe(0);
  } finally {
    restoreClock();
    renderer.destroy();
  }
  expect(signals[0]!.aborted).toBe(true);
  expect(scheduler.pendingCount).toBe(0);
});
