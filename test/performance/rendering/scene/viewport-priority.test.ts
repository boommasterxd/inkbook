import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { InteractiveWorkPriority } from "../../../../src/editor/session/interactive-work-priority";
import { SceneEntrantPriority } from "../../../../src/rendering/scene/scene-entrant-priority";
import { MountSlice } from "../../../../src/rendering/scene/mount-slice";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../src/rendering/scene/constants";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import {
  createPendingScenePathStore,
  createSceneFixture,
  createSceneRecord,
  observeIndexedSceneQueries,
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
      rank < SCENE_PUBLICATION_ROOTS_PER_FRAME + 64
        ? 36 + Math.floor(((rank - 64) * 19) / (SCENE_PUBLICATION_ROOTS_PER_FRAME - 1))
        : 10_000,
    ).element;
  });
  const domain = new ElementStore(elements);
  const scene = new ElementSceneStore(domain);
  const { query, work } = observeIndexedSceneQueries(domain);
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
    expect(renderer.mountedCount).toBe(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    expect(renderer.mountedIds("highlight")).toEqual([]);
    expect(renderer.mountedIds("content")).toHaveLength(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    flushBoundedScenePublication(renderer, scheduler);
    expect(renderer.mountedCount).toBe(SCENE_PUBLICATION_ROOTS_PER_FRAME + 64);
    expect(renderer.mountedIds("highlight")).toHaveLength(64);
    expect(renderer.mountedIds("content")).toHaveLength(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    expect(create.mock.calls.filter(([, tag]) => tag === "path")).toHaveLength(
      SCENE_PUBLICATION_ROOTS_PER_FRAME + 64,
    );
    expect(work.indexedVisits).toBeLessThanOrEqual((SCENE_PUBLICATION_ROOTS_PER_FRAME + 64) * 2);
    expect(query).toHaveBeenCalledOnce();
    expect(get.mock.calls.length).toBeLessThanOrEqual((SCENE_PUBLICATION_ROOTS_PER_FRAME + 64) * 6);
    expect(renderer.instrumentation().visibilityReconcileVisits).toBeLessThanOrEqual(
      (SCENE_PUBLICATION_ROOTS_PER_FRAME + 64) * 6,
    );
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

it("proves exact-viewport completion only after classification and publication across retargets", () => {
  const store = new FakeSceneStore();
  store.records.set("inside", fakeRectangleRecord("inside", 0, 20, 20));
  store.records.set("ahead", fakeRectangleRecord("ahead", 1, 20, 140));
  const priority = new SceneEntrantPriority(
    store.records.keys(),
    store,
    new Set(),
    createInstrumentation(),
    {
      viewport: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      direction: { x: 0, y: 1 },
    },
  );
  const get = vi.spyOn(store, "get");
  let clock = 0;
  expect(priority.hasViewportCandidates).toBe(true);
  expect(priority.build(new MountSlice(1, () => clock++))).toBe("deadline");
  expect(priority.hasViewportCandidates).toBe(true);
  expect(priority.build(new MountSlice(Infinity, () => 0))).toBeUndefined();
  expect(priority.take()).toBe("inside");
  expect(priority.hasViewportCandidates).toBe(true);
  priority.release("inside");
  priority.release("inside");
  expect(priority.hasViewportCandidates).toBe(false);
  expect(priority.count).toBe(1);
  const reads = get.mock.calls.length;
  priority.retarget([], [], {
    viewport: { minX: 0, minY: 100, maxX: 100, maxY: 200 },
    direction: { x: 0, y: 1 },
  });
  expect(priority.hasViewportCandidates).toBe(true);
  expect(priority.build(new MountSlice(Infinity, () => 0))).toBeUndefined();
  expect(priority.hasViewportCandidates).toBe(true);
  expect(get.mock.calls.length).toBe(reads);
  priority.release("ahead");
  expect(priority.hasViewportCandidates).toBe(false);
  priority.retarget([], [], undefined);
  expect(priority.hasViewportCandidates).toBe(true);
  priority.build(new MountSlice(Infinity, () => 0));
  expect(priority.hasViewportCandidates).toBe(false);
  expect(priority.memoryUsage()).toBe(0);
  get.mockRestore();
});

it.each([
  { exact: false, busy: false },
  { exact: true, busy: false },
  { exact: false, busy: true },
])(
  "defers leading reserve during an interactive lease while publishing the required scene: %j",
  async ({ exact, busy }) => {
    const reserveY = exact ? 900 : 600;
    const reserveStroke = {
      ...indexedStroke(600),
      pivot: { x: 20, y: reserveY },
      points: [20, reserveY, 0.5, 21, reserveY, 0.5],
    };
    const domain = new ElementStore(
      Array.from({ length: 10_000 }, (_, rank) =>
        rank === 600
          ? reserveStroke
          : fakeRectangleRecord(indexedStroke(rank).id, rank, 20, rank < 600 ? 450 : 10_000)
              .element,
      ),
    );
    const store = new ElementSceneStore(domain);
    const order: string[] = [];
    const prepare = vi.fn<NonNullable<typeof store.prepareScenePaths>>(() => {
      order.push("reserve");
      return new Promise(() => undefined);
    });
    store.prepareScenePaths = prepare;
    const { work } = observeIndexedSceneQueries(domain);
    const input = new InteractiveWorkPriority();
    input.setInputActive(true, "navigation");
    const wait = vi.fn(() => input.waitForBackground());
    const { renderer, scheduler } = createSceneFixture(
      NAVIGATION_PAGE,
      store,
      { height: 100, left: 0, top: 0, width: 100 },
      { waitForBackground: wait },
    );
    scheduler.runAll();
    const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
    const publication = busy
      ? observeSceneInsertions(content, (roots) => {
          expect(roots).toBeLessThanOrEqual(16);
          order.push("publication");
          scheduler.time += 8;
        })
      : undefined;
    try {
      renderer.setViewport({ height: 100, left: 0, top: exact ? 400 : 100, width: 100 });
      scheduler.runNext();
      expect(renderer.mountedCount).toBe(busy ? 16 : SCENE_PUBLICATION_ROOTS_PER_FRAME);
      expect(prepare).not.toHaveBeenCalled();
      if (busy) {
        scheduler.runNext();
        expect(order.slice(0, 2)).toEqual(["publication", "publication"]);
        expect(renderer.mountedCount).toBeLessThan(600);
      }
      while (renderer.mountedCount < 600) {
        const before = renderer.instrumentation().domRootsPublished;
        scheduler.runNext();
        expect(renderer.instrumentation().domRootsPublished - before).toBeLessThanOrEqual(
          SCENE_PUBLICATION_ROOTS_PER_FRAME,
        );
      }
      scheduler.runAll();
      expect(prepare).not.toHaveBeenCalled();
      expect(scheduler.pendingCount).toBe(0);
      input.setInputActive(false, "navigation");
      await wait.mock.results[0]!.value;
      expect(scheduler.pendingCount).toBe(1);
      scheduler.runAll();
      expect(prepare).toHaveBeenCalledOnce();
      expect(prepare.mock.calls[0]![0]).toEqual([reserveStroke.id]);
      expect(prepare.mock.calls[0]![2]?.navigationReserve).toBe(true);
      expect(work.indexedVisits).toBeLessThanOrEqual(2_000);
    } finally {
      publication?.mockRestore();
      renderer.destroy();
      input.dispose();
      store.release();
    }
    expect(prepare.mock.calls[0]![1].aborted).toBe(true);
    expect(scheduler.pendingCount).toBe(0);
  },
);

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
  // Exact-viewport membership retains one additional bounded Set slot per candidate.
  expect(priority.memoryUsage()).toBeLessThanOrEqual(10_000 * 152);
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
  expect(priority.memoryUsage()).toBeLessThanOrEqual(9_745 * 152);
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
    expect(priority.memoryUsage()).toBeLessThanOrEqual(candidates.length * 152);
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

it("detaches exits in bounded frames after the first new publication", () => {
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
    expect(frameRoots).toBeLessThanOrEqual(SCENE_PUBLICATION_ROOTS_PER_FRAME);
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
    ).toBe(64);
    expect(oldRemovals).toBe(64);
    expect(renderer.instrumentation().domExits).toBe(oldRemovals);
    expect(renderer.instrumentation().domEntrants).toBeLessThanOrEqual(66);
    expect([...oldNodes].filter((node) => node.parent === content)).toHaveLength(192);
    for (let frames = 0; scheduler.pendingCount > 0; frames += 1) {
      expect(frames).toBeLessThan(400);
      frameRoots = 0;
      const before = oldRemovals;
      scheduler.runNext();
      expect(oldRemovals - before).toBeLessThanOrEqual(64);
    }
    expect(renderer.mountedCount).toBe(512);
    expect(renderer.mountedIds("content")).toEqual(
      Array.from({ length: 512 }, (_, rank) => `cleanup-${rank + 256}`),
    );
    expect(oldRemovals).toBe(256);
    expect([...oldNodes].every((node) => node.parentNode === null)).toBe(true);
    expect(renderer.instrumentation().domExits).toBe(256);
    expect(renderer.instrumentation().detachedCacheEntries).toBe(256);
    expect(content.nodes).toHaveLength(512);
    expect(new Set(content.nodes).size).toBe(512);
    expect(renderer.instrumentation().detachedCacheBytes).toBeLessThanOrEqual(1024 * 1024);
  } finally {
    insertion.mockRestore();
    remove.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("finishes partially scanned old mounts while remote geometry waits, then stops scene polling", () => {
  const { store, signals } = createPendingScenePathStore();
  const oldCount = SCENE_PUBLICATION_ROOTS_PER_FRAME + 64;
  for (let rank = 0; rank < oldCount; rank += 1) {
    const id = `old-${rank}`;
    store.records.set(id, fakeRectangleRecord(id, rank, 20, 20));
  }
  store.records.set("warm", fakeRectangleRecord("warm", oldCount, 20, 1_010));
  const cold = {
    ...indexedStroke(33),
    pivot: { x: 20, y: 1_020 },
    points: [20, 1_020, 0.5, 30, 1_020, 0.5],
  };
  store.records.set(cold.id, createSceneRecord(cold, oldCount + 1));
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  renderer.setReducedMotion(true);
  scheduler.runNext();
  expect(renderer.mountedCount).toBe(SCENE_PUBLICATION_ROOTS_PER_FRAME);
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
    expect(oldNodes.every((node) => node.parentNode === null)).toBe(true);
    expect(renderer.instrumentation().domExits).toBe(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    expect(renderer.instrumentation().detachedCacheEntries).toBe(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    expect(content.nodes).toHaveLength(1);
    expect(new Set(content.nodes).size).toBe(1);
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
