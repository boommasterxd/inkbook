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
  observeSceneInsertions,
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
      rank < 256 ? 30 + rank / 10 : 10_000,
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
    expect(renderer.mountedCount).toBe(192);
    expect(renderer.mountedIds("highlight")).toEqual([]);
    expect(renderer.mountedIds("content")).toHaveLength(192);
    flushBoundedScenePublication(renderer, scheduler);
    expect(renderer.mountedCount).toBe(256);
    expect(renderer.mountedIds("highlight")).toHaveLength(64);
    expect(renderer.mountedIds("content")).toHaveLength(192);
    expect(create.mock.calls.filter(([, tag]) => tag === "path")).toHaveLength(256);
    expect(indexedVisits).toBeLessThanOrEqual(512);
    expect(query).toHaveBeenCalledOnce();
    expect(get.mock.calls.length).toBeLessThanOrEqual(1_536);
    expect(renderer.instrumentation().visibilityReconcileVisits).toBeLessThanOrEqual(1_536);
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
  // The priority owns cached bounds/keys until publication or membership exit.
  expect(priority.memoryUsage()).toBeLessThanOrEqual(10_000 * 120);
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
    expect(priority.memoryUsage()).toBeLessThanOrEqual(9_745 * 112);
  }
  get.mockClear();
  expect(priority.build(new MountSlice(Infinity, () => 0))).toBeUndefined();
  expect(get).toHaveBeenCalledOnce();
  const remaining = [...priority.upcoming(priority.count)];
  expect(new Set(remaining).size).toBe(9_745);
  expect(remaining).toContain("retarget-1999");
  expect(remaining.some((id) => id === "retarget-0")).toBe(false);
  expect(priority.memoryUsage()).toBeLessThanOrEqual(9_745 * 120);
  get.mockRestore();
});

it.each([
  { horizontal: false, sign: 1 },
  { horizontal: false, sign: -1 },
  { horizontal: true, sign: 1 },
  { horizontal: true, sign: -1 },
])(
  "prepares leading overscan before trailing work and reuses bounds for %j",
  ({ horizontal, sign }) => {
    const store = new FakeSceneStore();
    const candidates = [
      { id: "inside-early", coordinate: 20 },
      { id: "inside-late", coordinate: 70 },
      { id: "ahead-near", coordinate: 130 },
      { id: "ahead-far", coordinate: 160 },
      { id: "trailing-near", coordinate: -40 },
      { id: "trailing-far", coordinate: -80 },
      { id: "lateral", coordinate: 110 },
    ];
    candidates.forEach(({ id, coordinate }, index) => {
      const axis = sign > 0 ? coordinate : 80 - coordinate;
      const other = id === "lateral" ? 200 : 20;
      store.records.set(
        id,
        fakeRectangleRecord(id, index, horizontal ? axis : other, horizontal ? other : axis),
      );
    });
    const viewport = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
    const direction = { x: horizontal ? sign : 0, y: horizontal ? 0 : sign };
    const stats = createInstrumentation();
    const get = vi.spyOn(store, "get");
    const priority = new SceneEntrantPriority(store.records.keys(), store, new Set(), stats, {
      viewport,
      direction,
    });
    const slice = () => new MountSlice(Infinity, () => 0);
    expect(priority.build(slice())).toBeUndefined();
    expect([...priority.upcoming(7)]).toEqual([
      "inside-early",
      "inside-late",
      "lateral",
      "ahead-near",
      "ahead-far",
      "trailing-far",
      "trailing-near",
    ]);
    const offset = sign * 20;
    const shifted = horizontal
      ? { ...viewport, minX: offset, maxX: 100 + offset }
      : { ...viewport, minY: offset, maxY: 100 + offset };
    priority.retarget([], [], { viewport: shifted, direction });
    expect(priority.build(slice())).toBeUndefined();
    expect([...priority.upcoming(7)]).toEqual([
      "inside-early",
      "inside-late",
      "ahead-near",
      "ahead-far",
      "trailing-far",
      "trailing-near",
      "lateral",
    ]);
    priority.retarget([], [], {
      viewport: shifted,
      direction: { x: -direction.x, y: -direction.y },
    });
    expect(priority.build(slice())).toBeUndefined();
    expect([...priority.upcoming(7)]).toEqual([
      "inside-late",
      "inside-early",
      "trailing-near",
      "trailing-far",
      "ahead-far",
      "ahead-near",
      "lateral",
    ]);
    expect(get).toHaveBeenCalledTimes(candidates.length);
    expect(stats.visibilityReconcileVisits).toBe(candidates.length * 3);
    expect(priority.memoryUsage()).toBeLessThanOrEqual(candidates.length * 120);
    expect(Array.from({ length: 7 }, () => priority.take())).toEqual([
      "inside-late",
      "inside-early",
      "trailing-near",
      "trailing-far",
      "ahead-far",
      "ahead-near",
      "lateral",
    ]);
    expect(priority.count).toBe(0);
    for (const { id } of candidates) priority.release(id);
    expect(priority.memoryUsage()).toBe(0);
    get.mockRestore();
  },
);

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
  let frameRoots = 0;
  const insertion = observeSceneInsertions(content, (roots) => {
    expect(roots).toBeLessThanOrEqual(16);
    expect(scheduler.time).toBeLessThan(scheduler.workScheduler.deadline());
    frameRoots += roots;
    expect(frameRoots).toBeLessThanOrEqual(192);
    scheduler.time += 8;
  });
  try {
    const first = beginViewportPublication(renderer, scheduler, { ...viewport, top: 1_000 });
    expect(first.domEntrants).toBeGreaterThan(0);
    expect(first.domEntrants).toBe(frameRoots);
    expect(first.detachedCacheEntries).toBe(0);
    expect(oldRemovals).toBe(0);
    frameRoots = 0;
    scheduler.runNext();
    expect(
      renderer.instrumentation().detachedCacheEntries,
      JSON.stringify({
        ...renderer.instrumentation(),
        mountedCount: renderer.mountedCount,
        pendingCount: scheduler.pendingCount,
      }),
    ).toBe(256);
    expect(oldRemovals).toBe(0);
    expect(renderer.instrumentation().domExits).toBe(oldRemovals);
    expect(renderer.instrumentation().domEntrants).toBeLessThanOrEqual(66);
    expect([...oldNodes].filter((node) => node.parent === content)).toHaveLength(256);
    insertion.mockRestore();
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
    insertion.mockRestore();
    remove.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("finishes partially scanned old mounts while remote geometry waits, then stops scene polling", () => {
  const { store, signals } = createPendingScenePathStore();
  for (let rank = 0; rank < 256; rank += 1) {
    const id = `old-${rank}`;
    store.records.set(id, fakeRectangleRecord(id, rank, 20, 20));
  }
  store.records.set("warm", fakeRectangleRecord("warm", 256, 20, 1_010));
  const cold = {
    ...indexedStroke(33),
    pivot: { x: 20, y: 1_020 },
    points: [20, 1_020, 0.5, 30, 1_020, 0.5],
  };
  store.records.set(cold.id, createSceneRecord(cold, 257));
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  renderer.setReducedMotion(true);
  scheduler.runNext();
  expect(renderer.mountedCount).toBe(192);
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
    expect(renderer.instrumentation().detachedCacheEntries).toBe(192);
    expect(content.nodes).toHaveLength(193);
    expect(new Set(content.nodes).size).toBe(193);
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
