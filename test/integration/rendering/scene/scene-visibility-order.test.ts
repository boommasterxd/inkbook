import { expect, it, vi } from "vitest";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../src/rendering/scene/constants";

import {
  createPendingScenePathStore,
  createSceneFixture,
  createSceneRecord,
  createViewportRectangleStore,
} from "../../../fixtures/rendering/scene";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import {
  FakeSceneStore,
  FakeScheduler,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

it("restarts staged immutable ranks after an order-only change during classification", () => {
  const scheduler = new FakeScheduler();
  const store = createViewportRectangleStore(20, () => 10);
  const ids = [...store.records.keys()];
  const get = vi.spyOn(store, "get").mockImplementation((id) => {
    scheduler.time += 1;
    const record = store.records.get(id);
    return record === undefined ? undefined : { ...record };
  });
  const { renderer } = createSceneFixture(
    NAVIGATION_PAGE,
    store,
    { height: 100, left: 0, top: 0, width: 100 },
    {},
    scheduler,
  );
  scheduler.runNext();
  expect(renderer.mountedCount).toBe(0);
  expect(get.mock.calls.length).toBeGreaterThan(0);
  expect(get.mock.calls.length).toBeLessThan(ids.length);
  const first = store.records.get(ids[0]!)!;
  store.records.set(first.id, { ...first, rank: ids.length });
  renderer.applyDelta({ affected: [{ domains: ["order"], id: first.id }] });
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual([...ids.slice(1), first.id]);
  expect(renderer.instrumentation().spatialQueries).toBe(1);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it("merges viewport entrants into band order and sorts after a rank change", () => {
  const store = new FakeSceneStore();
  const first = fakeRectangleRecord("first", 10, 10);
  const last = fakeRectangleRecord("last", 30, 10);
  const entrant = fakeRectangleRecord("entrant", 20, 10, 440);
  const nextEntrant = fakeRectangleRecord("next-entrant", 15, 10, 490);
  for (const record of [first, last, entrant, nextEntrant]) store.records.set(record.id, record);
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, {
    height: 100,
    left: 0,
    top: 0,
    width: 100,
  });
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(["first", "last"]);
  const camera = fakeNode(renderer.svg).nodes[1]!;
  const highlightGroup = camera.nodes[3]!;
  const contentGroup = camera.nodes[4]!;
  const firstNode = contentGroup.nodes[0]!;

  store.records.set(first.id, { ...first, band: "highlight" });
  renderer.applyDelta({ affected: [{ id: first.id, domains: ["order", "visibility"] }] });
  renderer.setViewport({ height: 100, left: 0, top: 50, width: 100 });
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(["entrant", "last"]);
  expect(renderer.mountedIds("highlight")).toEqual(["first"]);
  expect(firstNode.parent).toBe(highlightGroup);

  store.records.set(last.id, { ...last, rank: 5 });
  renderer.resetInstrumentation();
  renderer.applyDelta({ affected: [{ id: last.id, domains: ["order"] }] });
  renderer.setViewport({ height: 100, left: 0, top: 151, width: 100 });
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(["last", "next-entrant", "entrant"]);
  expect(renderer.instrumentation().domReorders).toBeGreaterThan(0);

  store.records.set(first.id, { ...first, rank: 12 });
  renderer.applyDelta({ affected: [{ id: first.id, domains: ["order", "visibility"] }] });
  renderer.setViewport({ height: 100, left: 0, top: 50, width: 100 });
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(["last", "first", "entrant"]);
  expect(renderer.mountedIds("highlight")).toEqual([]);
  expect(firstNode.parent).toBe(contentGroup);
  expect(contentGroup.nodes[1]).toBe(firstNode);
  renderer.destroy();
});

it.each([
  { name: "down", horizontal: false, initial: 0, sign: 1 },
  { name: "up", horizontal: false, initial: 2_000, sign: -1 },
  { name: "right", horizontal: true, initial: 0, sign: 1 },
  { name: "left", horizontal: true, initial: 2_000, sign: -1 },
])("prepares entrants along $name navigation while preserving final SVG rank", (scenario) => {
  const store = new FakeSceneStore();
  const ids = Array.from(
    { length: SCENE_PUBLICATION_ROOTS_PER_FRAME * 2 },
    (_, rank) => `direction-${rank}`,
  );
  ids.forEach((id, rank) => {
    const coordinate = 1_020 + (rank * 48) / ids.length;
    store.records.set(
      id,
      fakeRectangleRecord(
        id,
        rank,
        scenario.horizontal ? coordinate : 20,
        scenario.horizontal ? 20 : coordinate,
      ),
    );
  });
  const viewport = {
    height: 100,
    left: 0,
    top: scenario.horizontal ? 0 : scenario.initial,
    width: 100,
  };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  if (scenario.horizontal) renderer.setCamera({ x: -scenario.initial, zoom: 1 });
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(0);
  if (scenario.horizontal) renderer.setCamera({ x: -1_000, zoom: 1 });
  else renderer.setViewport({ ...viewport, top: 1_000 });
  scheduler.runNext();
  expect(renderer.mountedIds("content")).toEqual(
    scenario.sign > 0
      ? ids.slice(0, SCENE_PUBLICATION_ROOTS_PER_FRAME)
      : ids.slice(SCENE_PUBLICATION_ROOTS_PER_FRAME),
  );
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(ids);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  expect(content.nodes).toHaveLength(ids.length);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it.each([
  { name: "down", horizontal: false, sign: 1 },
  { name: "up", horizontal: false, sign: -1 },
  { name: "right", horizontal: true, sign: 1 },
  { name: "left", horizontal: true, sign: -1 },
])("follows $name navigation when one clip edge stays fixed", ({ horizontal, sign }) => {
  const store = new FakeSceneStore();
  const ids = Array.from(
    { length: SCENE_PUBLICATION_ROOTS_PER_FRAME * 2 },
    (_, index) => `clipped-${index}`,
  );
  ids.forEach((id, index) => {
    const coordinate = 420 + (index * 384) / ids.length;
    store.records.set(
      id,
      fakeRectangleRecord(
        id,
        ids.length - index - 1,
        horizontal ? coordinate : 20,
        horizontal ? 20 : coordinate,
      ),
    );
  });
  const initial = sign > 0 ? 0 : 1_200;
  const viewport = {
    height: 100,
    left: horizontal ? initial : 0,
    top: horizontal ? 0 : initial,
    width: 100,
  };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(0);
  renderer.setViewport({
    ...viewport,
    ...(horizontal
      ? { left: 0, width: sign > 0 ? 1_200 : 1_300 }
      : { top: 0, height: sign > 0 ? 1_200 : 1_300 }),
  });
  scheduler.runNext();
  expect(renderer.mountedIds("content")).toEqual(
    (sign > 0
      ? ids.slice(0, SCENE_PUBLICATION_ROOTS_PER_FRAME)
      : ids.slice(SCENE_PUBLICATION_ROOTS_PER_FRAME)
    ).reverse(),
  );
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual([...ids].reverse());
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it("publishes a cached entrant while the earlier cold stroke waits for the worker", () => {
  const { store, signals } = createPendingScenePathStore();
  const warm = fakeRectangleRecord("warm", 1, 20, 110);
  const stroke = {
    ...indexedStroke(0),
    pivot: { x: 20, y: 500 },
    points: [20, 500, 0.5, 30, 500, 0.5],
  };
  store.records.set(warm.id, warm);
  store.records.set(stroke.id, createSceneRecord(stroke, 0));
  const viewport = { height: 50, left: 0, top: 100, width: 100 };
  const { renderer, scheduler, document } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  scheduler.runAll();
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  const retained = content.nodes[0]!;
  renderer.setViewport({ ...viewport, top: 1_000 });
  scheduler.runAll();
  expect(retained.parent).toBeUndefined();
  expect(content.nodes).toHaveLength(0);
  expect(renderer.instrumentation().detachedCacheEntries).toBe(1);
  renderer.resetInstrumentation();
  const create = vi.spyOn(document, "createElementNS");
  renderer.setViewport({ ...viewport, height: 200 });
  scheduler.runAll();
  expect(signals).toHaveLength(1);
  expect(renderer.mountedIds("content")).toEqual([warm.id]);
  expect(content.nodes[0]).toBe(retained);
  expect(retained.parent).toBe(content);
  expect(renderer.instrumentation()).toMatchObject({
    geometryBuilds: 0,
    detachedCacheHits: 1,
    domEntrants: 1,
    domRootsPublished: 1,
  });
  expect(create.mock.calls.filter(([, tag]) => tag === "path")).toHaveLength(0);
  expect(scheduler.pendingCount).toBe(0);
  renderer.destroy();
  expect(signals[0]!.aborted).toBe(true);
});

it("prioritizes the viewport center when zoom reveals missing elements", () => {
  const store = new FakeSceneStore();
  const ids = Array.from(
    { length: SCENE_PUBLICATION_ROOTS_PER_FRAME * 2 },
    (_, rank) => `zoom-${String(rank).padStart(3, "0")}`,
  );
  const spacing = 384 / ids.length;
  ids.forEach((id, rank) =>
    store.records.set(id, fakeRectangleRecord(id, rank, 490, 300 + rank * spacing)),
  );
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, {
    height: 100,
    left: 0,
    top: 0,
    width: 100,
  });
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(0);
  renderer.setCamera({ x: 0, zoom: 0.1 });
  scheduler.runNext();
  const first = Math.ceil((500 - 310) / spacing - SCENE_PUBLICATION_ROOTS_PER_FRAME / 2);
  expect(renderer.mountedIds("content")).toEqual(
    ids.slice(first, first + SCENE_PUBLICATION_ROOTS_PER_FRAME),
  );
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(ids);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});
