import { expect, it, vi } from "vitest";
import { UniformSpatialIndex } from "../../../../src/domain/spatial";
import { SceneVisibilityState } from "../../../../src/rendering/scene/visibility-state";
import { NavigationPathPreparation } from "../../../../src/rendering/scene/navigation-path-preparation";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import type { SceneElementRecord, SceneStorePort } from "../../../../src/rendering/scene/types";
import {
  FakeSceneStore,
  FakeScheduler,
  FakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { createSceneRecord, createSceneFixture } from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";

const BOUNDS = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const BUDGET = INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs;

function indexedStore(records: readonly SceneElementRecord[]) {
  const fake = new FakeSceneStore();
  const index = new UniformSpatialIndex<string>();
  for (const record of records) fake.records.set(record.id, record);
  index.insertMany(records.map(({ id, bounds }) => ({ id, bounds })));
  const work = { units: 0, clock: 0, cancellations: 0 };
  const store: SceneStorePort = {
    get: (id) => fake.get(id),
    query: () => {
      throw new Error("Navigation must use the indexed cursor.");
    },
    beginQuery: (bounds) => {
      const cursor = index.beginQuery(bounds);
      return {
        advance: (limit) => {
          const step = cursor.advance(limit);
          work.units += step.workUnits;
          work.clock += step.workUnits;
          return step;
        },
        cancel: () => {
          work.cancellations += 1;
          cursor.cancel();
        },
        memoryUsage: () => cursor.memoryUsage(),
      };
    },
  };
  return { fake, index, work, store };
}

it("interrupts dense real indexed queries, rejects stale generations and retargets without partial membership", () => {
  const records = Array.from({ length: 10_000 }, (_, rank) =>
    fakeRectangleRecord(`entry-${rank}`, rank, 20, rank < 9_000 ? 50 : 191),
  );
  const { store, index, work } = indexedStore(records);
  const state = new SceneVisibilityState(store, createInstrumentation());
  const first = state.query(BOUNDS, BOUNDS, true, BUDGET, () => work.clock);
  expect(first.pending).toBe(true);
  expect(first.visibility.content.count).toBe(0);
  expect(state.queryMemoryUsage()).toBeGreaterThan(0);
  expect(work.units).toBeLessThanOrEqual(Math.ceil(BUDGET));
  index.remove("entry-0");
  expect(state.query(BOUNDS, BOUNDS).pending).toBe(true);
  const initial = state.query(BOUNDS, BOUNDS);
  expect(initial.visibility.content.count).toBe(8_999);
  const next = { ...BOUNDS, minY: 50, maxY: 200 };
  const before = work.units;
  work.clock = 0;
  expect(state.query(next, next, true, BUDGET, () => work.clock).pending).toBe(true);
  expect(work.units - before).toBeLessThanOrEqual(Math.ceil(BUDGET));
  expect(state.contains("entry-9999")).toBe(false);
  expect(state.query(BOUNDS, BOUNDS).changed).toBe(false);
  const complete = state.query(next, next);
  expect(complete.delta?.entered).toHaveLength(1_000);
  expect(complete.visibility.content.count).toBe(9_999);
  expect(work.units).toBeLessThan(100_000);
  state.release();
  expect(state.queryMemoryUsage()).toBe(0);
  expect(work.cancellations).toBeGreaterThan(0);
});

it("classifies a dense acquired query under the same deadline while retaining atomic visible membership", () => {
  const records = Array.from({ length: 10_000 }, (_, rank) =>
    fakeRectangleRecord(`entry-${rank}`, rank, 20, 50),
  );
  const { store } = indexedStore(records);
  const state = new SceneVisibilityState(store, createInstrumentation());
  let clock = 0;
  const get = vi.spyOn(store, "get").mockImplementation((id) => {
    clock += 1;
    return records[Number(id.slice(6))];
  });
  const result = state.query(BOUNDS, BOUNDS, true, BUDGET, () => clock);
  expect(result.pending).toBe(true);
  expect(result.visibility.content.count).toBe(0);
  expect(state.contains("entry-0")).toBe(false);
  expect(get.mock.calls.length).toBeLessThanOrEqual(Math.ceil(BUDGET));
  const slotReads = vi.spyOn(Map.prototype, "get");
  let reads: number;
  try {
    expect(state.query(BOUNDS, BOUNDS).visibility.content.count).toBe(10_000);
    reads = slotReads.mock.calls.length;
  } finally {
    slotReads.mockRestore();
  }
  // Actual slot/rank lookups include final marker adoption and the existing heap-sort comparisons.
  expect(reads).toBeGreaterThanOrEqual(10_000);
  expect(reads).toBeLessThanOrEqual(700_000);
  expect(get).toHaveBeenCalledTimes(10_000);
  state.release();
  expect(state.queryMemoryUsage()).toBe(0);
});

it("defers atomic marker/order adoption when the last exact record consumes the deadline", () => {
  const record = fakeRectangleRecord("entry-0", 0, 20, 50);
  const { store } = indexedStore([record]);
  const state = new SceneVisibilityState(store, createInstrumentation());
  let clock = 0;
  const get = vi.spyOn(store, "get").mockImplementation(() => {
    clock = BUDGET;
    return record;
  });
  const sorted = vi.spyOn(Array.prototype, "sort");
  try {
    expect(state.query(BOUNDS, BOUNDS, true, BUDGET, () => clock).pending).toBe(true);
    expect(state.contains(record.id)).toBe(false);
    expect(sorted).not.toHaveBeenCalled();
    expect(state.query(BOUNDS, BOUNDS).visibility.content.count).toBe(1);
    expect(get).toHaveBeenCalledOnce();
  } finally {
    sorted.mockRestore();
    state.release();
  }
});

function directionalFixture(count = 10_000, firstY = 120) {
  const records = Array.from({ length: count }, (_, rank) => {
    const y = rank < 300 ? firstY : 10_000;
    const element = {
      ...indexedStroke(rank),
      pivot: { x: 20, y },
      points: [20, y, 0.5, 21, y, 0.5],
    };
    return createSceneRecord(element, rank);
  });
  const indexed = indexedStore(records);
  const cache = new ScenePathCache();
  const preparation = new NavigationPathPreparation(indexed.store, cache);
  const priority = { viewport: BOUNDS, direction: { x: 0, y: 1 } };
  return { ...indexed, cache, preparation, priority, records };
}

it("bounds directional candidates and contour ownership, reuses prepared geometry and cancels reversals", () => {
  const { work, store, cache, preparation, priority, records } = directionalFixture();
  const get = vi.spyOn(store, "get");
  const builds = vi.spyOn(cache, "startPreparation");
  preparation.setTarget(priority, BOUNDS);
  expect(preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(builds).toHaveBeenCalledTimes(256);
  expect(get.mock.calls.length).toBeLessThanOrEqual(512);
  expect(work.units).toBeLessThanOrEqual(270);
  expect(cache.statistics().entries).toBeLessThanOrEqual(256);
  expect(preparation.memoryUsage()).toBe(0);
  preparation.cancel();
  preparation.setTarget(priority, BOUNDS);
  expect(preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(builds).toHaveBeenCalledTimes(256);
  preparation.setTarget({ ...priority, direction: { x: 0, y: -1 } }, BOUNDS);
  preparation.prepare(Infinity, () => 0);
  expect(cache.has(records[0]!.id, 1)).toBe(true);
  preparation.cancel();
  expect(preparation.memoryUsage()).toBe(0);
});

it("drains directional work through one background callback without repeating spent scene frames", () => {
  const { store, work } = directionalFixture(10_000, 550);
  const scheduler = new FakeScheduler(() => BUDGET);
  const { renderer } = createSceneFixture(
    NAVIGATION_PAGE,
    store,
    { height: 100, left: 0, top: 0, width: 100 },
    {},
    scheduler,
  );
  scheduler.runAll();
  let entryRead = false;
  const now = vi.spyOn(scheduler, "now").mockImplementation(() => {
    const current = scheduler.time;
    if (!entryRead) scheduler.time += BUDGET / 8;
    entryRead = false;
    return current;
  });
  const request = scheduler.workScheduler.requestFrame.bind(scheduler.workScheduler);
  const handles = new Set<number>();
  let maximum = 0;
  vi.spyOn(scheduler.workScheduler, "requestFrame").mockImplementation((callback, priority) => {
    const handle = request((time) => {
      handles.delete(handle);
      callback(time);
    }, priority);
    if (priority === "background") handles.add(handle);
    maximum = Math.max(maximum, handles.size);
    return handle;
  });
  try {
    renderer.resetInstrumentation();
    renderer.setViewport({ height: 100, left: 0, top: 50, width: 100 });
    let frames = 0;
    while (scheduler.pendingCount > 0) {
      expect(++frames).toBeLessThanOrEqual(256 * 3 + 64);
      entryRead = true;
      scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
      scheduler.runNext();
    }
    expect(maximum).toBe(1);
    expect(handles.size).toBe(0);
    // Indexed fringe acquisition and its atomic adoption use at most two required scene frames.
    expect(renderer.instrumentation().frames).toBeLessThanOrEqual(2);
    expect(renderer.instrumentation().pathCacheEntries).toBe(256);
    // The leading cursor admits at most 256 of the 300 future records.
    // Regional traversals remain inside the existing cell/iterator work bound.
    expect(work.units).toBeLessThanOrEqual(300 + 256 + 44);
  } finally {
    now.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("keeps directional work within the frame deadline and releases a suspended contour on version replacement", () => {
  const { work, fake, cache, preparation, priority, records } = directionalFixture(1);
  const record = records[0]!;
  cache.invalidate(record.id);
  preparation.setTarget(priority, BOUNDS);
  const step = vi.spyOn(cache, "startPreparation").mockImplementationOnce(
    () =>
      ({
        memoryUsage: () => 2_433_392,
        cancel: vi.fn(),
        step: () => {
          work.clock = BUDGET;
          return false;
        },
      }) as unknown as ReturnType<ScenePathCache["startPreparation"]>,
  );
  work.clock = -10;
  expect(preparation.prepare(BUDGET, () => work.clock)).toBe(true);
  expect(work.units).toBeLessThanOrEqual(Math.ceil(BUDGET));
  expect(preparation.memoryUsage()).toBeGreaterThanOrEqual(2_433_392);
  expect(preparation.memoryUsage()).toBeLessThanOrEqual(2_434_000);
  fake.records.set(record.id, { ...record, geometryVersion: 2 });
  expect(preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(cache.has(record.id, 1)).toBe(false);
  expect(preparation.memoryUsage()).toBe(0);
  expect(step).toHaveBeenCalledOnce();
  preparation.cancel();
});

it("reuses the same maximum-stroke preparation across overlapping directional retargets and cancels required entrants", () => {
  const samples = Array.from({ length: 16_384 }, (_, sample) => [
    20 + sample / 2_000,
    120,
    0.5,
  ]).flat();
  const element = { ...indexedStroke(0), pivot: { x: 24, y: 120 }, points: samples };
  let reads = 0;
  const points = new Proxy(samples, {
    get: (target, property, receiver) => {
      if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const record = { ...createSceneRecord(element), element: { ...element, points } };
  const { store, work } = indexedStore([record]);
  const cache = new ScenePathCache();
  const preparation = new NavigationPathPreparation(store, cache);
  const original = cache.startPreparation.bind(cache);
  let steps = 0;
  const cancel = vi.fn();
  const builds = vi.spyOn(cache, "startPreparation").mockImplementation((stroke, pressure) => {
    const job = original(stroke, pressure);
    const step = job.step.bind(job);
    vi.spyOn(job, "step").mockImplementation((deadline, now) => {
      steps += 1;
      const done = step(deadline, now);
      work.clock = deadline ?? BUDGET;
      return done;
    });
    const release = job.cancel.bind(job);
    vi.spyOn(job, "cancel").mockImplementation(() => {
      cancel();
      release();
    });
    return job;
  });
  const priority = { viewport: BOUNDS, direction: { x: 0, y: 1 } };
  for (const shift of [0, 1, 2, 3]) {
    work.clock = -10;
    preparation.setTarget(priority, { ...BOUNDS, minY: shift, maxY: 100 + shift });
    preparation.pause();
    const before = reads;
    expect(preparation.prepare(BUDGET, () => work.clock)).toBe(true);
    expect(reads - before).toBeGreaterThan(0);
    // A progressive step admits at most 65 centers; repeated neighbor smoothing reads stay bounded.
    expect(reads - before).toBeLessThanOrEqual(650);
    expect(builds).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  }
  expect(steps).toBe(4);
  preparation.setTarget(priority, { ...BOUNDS, minY: 30, maxY: 130 });
  expect(cancel).toHaveBeenCalledOnce();
  expect(preparation.memoryUsage()).toBe(0);
  expect(cache.has(record.id, 1)).toBe(false);
  preparation.cancel();
});

function denseDirectionalHarness() {
  const scheduler = new FakeScheduler(() => BUDGET);
  const work = { pointReads: 0, inputActive: false };
  const records = Array.from({ length: 10_000 }, (_, rank) => {
    if (rank < 1_000 || rank >= 1_176)
      return fakeRectangleRecord(`entry-${rank}`, rank, 20, rank < 1_000 ? 150 : 10_000);
    const element = {
      ...indexedStroke(rank),
      pivot: { x: 20, y: 550 },
      points: [20, 550, 0.5, 21, 550, 0.5],
    };
    const record = createSceneRecord(element, rank);
    const points = new Proxy(element.points, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          work.pointReads += 1;
          scheduler.time += BUDGET / 32;
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    return { ...record, element: { ...element, points } };
  });
  const indexed = indexedStore(records);
  const query = indexed.store.beginQuery!.bind(indexed.store);
  indexed.store.beginQuery = (bounds) => {
    const cursor = query(bounds);
    if (bounds.minY < 390) return cursor;
    return {
      ...cursor,
      advance(limit) {
        const result = cursor.advance(limit);
        scheduler.time += (result.workUnits * BUDGET) / 4;
        return result;
      },
    };
  };
  const scene = createSceneFixture(
    NAVIGATION_PAGE,
    indexed.store,
    { height: 100, left: 0, top: 0, width: 100 },
    { isInputActive: () => work.inputActive },
    scheduler,
  );
  scheduler.runAll();
  expect(scene.renderer.mountedCount).toBe(1_000);
  expect(work.pointReads).toBe(0);
  return { ...scene, indexed, work };
}

it("prepares dense leading contours after required work without DOM publication and reuses them on scroll", () => {
  const { renderer, document, scheduler, indexed, work } = denseDirectionalHarness();
  const create = vi.spyOn(document, "createElementNS");
  const insert = vi.spyOn(FakeNode.prototype, "insertBefore");
  const write = vi.spyOn(FakeNode.prototype, "setAttribute");
  const remove = vi.spyOn(FakeNode.prototype, "remove");
  const original = Object.getOwnPropertyDescriptor(NavigationPathPreparation.prototype, "prepare")!
    .value as NavigationPathPreparation["prepare"];
  const prepare = vi.spyOn(NavigationPathPreparation.prototype, "prepare");
  prepare.mockImplementation(function (this: NavigationPathPreparation, deadline, now) {
    expect(renderer.mountedCount).toBe(1_000);
    const before = [create, insert, write, remove].map((spy) => spy.mock.calls.length);
    const pending = original.call(this, deadline, now);
    expect([create, insert, write, remove].map((spy) => spy.mock.calls.length)).toEqual(before);
    return pending;
  });
  try {
    renderer.resetInstrumentation();
    const before = indexed.work.units;
    renderer.setViewport({ height: 100, left: 0, top: 50, width: 100 });
    let frames = 0;
    while (scheduler.pendingCount > 0) {
      expect(++frames).toBeLessThanOrEqual(300);
      scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
      scheduler.runNext();
    }
    expect(prepare).toHaveBeenCalled();
    expect(work.pointReads).toBeGreaterThan(0);
    expect(work.pointReads).toBeLessThanOrEqual(176 * 32);
    // Required fringes and leading preparation retain separate bounded indexed queries.
    expect(indexed.work.units - before).toBeLessThanOrEqual(2 * 1_000 + 2 * 176 + 64);
    expect(renderer.instrumentation()).toMatchObject({
      domEntrants: 0,
      domExits: 0,
      geometryBuilds: 176,
      pathCacheEntries: 176,
    });
    expect(create).not.toHaveBeenCalled();
    prepare.mockRestore();
    work.inputActive = true;
    work.pointReads = 0;
    renderer.resetInstrumentation();
    renderer.setViewport({ height: 100, left: 0, top: 230, width: 100 });
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(1_176);
    expect(renderer.instrumentation()).toMatchObject({ geometryBuilds: 0, domEntrants: 176 });
    expect(work.pointReads).toBe(0);
  } finally {
    prepare.mockRestore();
    create.mockRestore();
    insert.mockRestore();
    write.mockRestore();
    remove.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("suppresses dense leading work during gestures and releases a suspended cursor under memory pressure", () => {
  const { renderer, scheduler, indexed, work } = denseDirectionalHarness();
  const prepare = vi.spyOn(NavigationPathPreparation.prototype, "prepare");
  try {
    work.inputActive = true;
    renderer.setViewport({ height: 100, left: 0, top: 50, width: 100 });
    scheduler.runAll();
    expect(prepare).not.toHaveBeenCalled();
    expect(work.pointReads).toBe(0);
    const settledBytes = renderer.memoryUsage().pathCacheBytes;
    work.inputActive = false;
    renderer.setViewport({ height: 100, left: 0, top: 60, width: 100 });
    scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
    scheduler.runNext();
    expect(prepare).toHaveBeenCalled();
    expect(scheduler.pendingCount).toBe(1);
    expect(renderer.memoryUsage().pathCacheBytes).toBeGreaterThan(settledBytes);
    const before = indexed.work.units;
    const cancellations = indexed.work.cancellations;
    renderer.setActiveDocumentMemoryPressure(true);
    expect(scheduler.pendingCount).toBe(0);
    expect(indexed.work.units).toBe(before);
    expect(indexed.work.cancellations).toBeGreaterThan(cancellations);
    expect(renderer.memoryUsage().pathCacheBytes).toBe(settledBytes);
    expect(work.pointReads).toBe(0);
  } finally {
    prepare.mockRestore();
    renderer.destroy();
  }
});
