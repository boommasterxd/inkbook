import { expect, it, vi } from "vitest";
import { UniformSpatialIndex } from "../../../../src/domain/spatial";
import type { Bounds } from "../../../../src/domain/geometry/primitives";
import { NavigationPathPreparation } from "../../../../src/rendering/scene/navigation-path-preparation";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import type { SceneStorePort } from "../../../../src/rendering/scene/types";
import { createSceneRecord, createSceneFixture } from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { FakeScheduler } from "./fakes";

const BOUNDS = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

function fixture(x: number, y: number) {
  const element = { ...indexedStroke(0), pivot: { x, y }, points: [x, y, 0.5, x + 1, y, 0.5] };
  const record = createSceneRecord(element);
  const index = new UniformSpatialIndex<string>();
  index.insert(record.id, record.bounds);
  const query = vi.fn((bounds: Bounds) => index.beginQuery(bounds));
  const store: SceneStorePort = { get: () => record, query: vi.fn(), beginQuery: query };
  const cache = new ScenePathCache();
  return {
    store,
    index,
    query,
    cache,
    record,
    preparation: new NavigationPathPreparation(store, cache),
  };
}

it.each([
  { x: 1, y: 0, sampleX: 120, sampleY: 50 },
  { x: -1, y: 0, sampleX: -20, sampleY: 50 },
  { x: 0, y: 1, sampleX: 50, sampleY: 120 },
  { x: 0, y: -1, sampleX: 50, sampleY: -20 },
])(
  "prepares the leading region for direction $x/$y and reuses the canonical cache",
  ({ x, y, sampleX, sampleY }) => {
    const { preparation, cache, record } = fixture(sampleX, sampleY);
    const priority = { viewport: BOUNDS, direction: { x, y } };
    preparation.setTarget(priority, BOUNDS);
    expect(preparation.prepare(Infinity, () => 0)).toBe(false);
    expect(cache.has(record.id, 1)).toBe(true);
    const builds = vi.spyOn(cache, "startPreparation");
    preparation.setTarget(priority, BOUNDS);
    preparation.prepare(Infinity, () => 0);
    preparation.cancel();
    preparation.setTarget(priority, BOUNDS);
    preparation.prepare(Infinity, () => 0);
    expect(builds).not.toHaveBeenCalled();
    expect(preparation.memoryUsage()).toBe(0);
  },
);

it("does not query when direction or the indexed query port is unavailable", () => {
  const { preparation, query, store, cache } = fixture(50, 120);
  preparation.setTarget(undefined, BOUNDS);
  preparation.setTarget({ viewport: BOUNDS, direction: { x: 0, y: 0 } }, BOUNDS);
  expect(preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(query).not.toHaveBeenCalled();
  const local = new NavigationPathPreparation(
    { get: (id) => store.get(id), query: (bounds, sink) => store.query(bounds, sink) },
    cache,
  );
  local.setTarget({ viewport: BOUNDS, direction: { x: 1, y: 0 } }, BOUNDS);
  expect(local.prepare(Infinity, () => 0)).toBe(false);
});

it("cancels a suspended indexed query on reversal and rejects stale generation work", () => {
  const { preparation, index, record, cache } = fixture(50, 120);
  const priority = { viewport: BOUNDS, direction: { x: 0, y: 1 } };
  preparation.setTarget(priority, BOUNDS);
  let calls = 0;
  expect(preparation.prepare(1, () => calls++)).toBe(true);
  expect(preparation.memoryUsage()).toBeGreaterThan(0);
  index.remove(record.id);
  expect(preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(cache.has(record.id, 1)).toBe(false);
  expect(preparation.memoryUsage()).toBe(0);
  preparation.setTarget(priority, BOUNDS);
  calls = 0;
  preparation.prepare(1, () => calls++);
  preparation.setTarget({ ...priority, direction: { x: 0, y: -1 } }, BOUNDS);
  expect(preparation.memoryUsage()).toBe(0);
  preparation.cancel();
});

it("runs directional preparation after visible work and suppresses it during drawing and memory pressure", () => {
  const { store } = fixture(50, 330);
  let inputActive = true;
  const { renderer, scheduler } = createSceneFixture(
    NAVIGATION_PAGE,
    store,
    { height: 100, left: 0, top: 0, width: 100 },
    { isInputActive: () => inputActive },
  );
  const prepare = vi.spyOn(NavigationPathPreparation.prototype, "prepare");
  try {
    scheduler.runAll();
    renderer.setViewport({ height: 100, left: 0, top: 50, width: 100 });
    scheduler.runAll();
    expect(prepare).not.toHaveBeenCalled();
    inputActive = false;
    renderer.setViewport({ height: 100, left: 0, top: 60, width: 100 });
    scheduler.runAll();
    expect(prepare).toHaveBeenCalled();
    prepare.mockClear();
    renderer.setActiveDocumentMemoryPressure(true);
    renderer.setViewport({ height: 100, left: 0, top: 70, width: 100 });
    scheduler.runAll();
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("finishes the retained contour before querying entrants from the replacement directional region", () => {
  const { preparation, record, cache, store, index } = fixture(50, 120);
  const element = {
    ...indexedStroke(1),
    pivot: { x: 50, y: 152 },
    points: [50, 152, 0.5, 51, 152, 0.5],
  };
  const entrant = createSceneRecord(element, 1);
  index.insert(entrant.id, entrant.bounds);
  store.get = (id) => (id === record.id ? record : entrant);
  const start = cache.startPreparation.bind(cache);
  let clock = 0;
  let suspend = true;
  const builds = vi.spyOn(cache, "startPreparation").mockImplementation((stroke, pressure) => {
    const job = start(stroke, pressure);
    if (stroke.id !== record.id) return job;
    const advance = job.step.bind(job);
    vi.spyOn(job, "step").mockImplementation((deadline, now) => {
      const done = advance(deadline, now);
      if (!suspend) return done;
      suspend = false;
      clock = 1;
      return false;
    });
    return job;
  });
  const priority = { viewport: BOUNDS, direction: { x: 0, y: 1 } };
  preparation.setTarget(priority, BOUNDS);
  expect(preparation.prepare(1, () => clock)).toBe(true);
  preparation.setTarget(priority, { ...BOUNDS, minY: 5, maxY: 105 });
  expect(preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(builds).toHaveBeenCalledTimes(2);
  expect(cache.has(record.id, 1)).toBe(true);
  expect(cache.has(entrant.id, 1)).toBe(true);
  expect(preparation.memoryUsage()).toBe(0);
  preparation.cancel();
});

it("shares the background callback deadline with required input and cancels it before context changes or disposal", () => {
  const { store } = fixture(50, 330);
  const scheduler = new FakeScheduler();
  const { renderer } = createSceneFixture(
    NAVIGATION_PAGE,
    store,
    { height: 100, left: 0, top: 0, width: 100 },
    {},
    scheduler,
  );
  scheduler.runAll();
  const prepare = vi.spyOn(NavigationPathPreparation.prototype, "prepare");
  const cancel = vi.spyOn(scheduler.workScheduler, "cancelFrame");
  try {
    prepare.mockImplementationOnce(() => true);
    renderer.setViewport({ height: 100, left: 0, top: 50, width: 100 });
    scheduler.runNext();
    expect(prepare).toHaveBeenCalledOnce();
    const input = vi.fn(() => {
      scheduler.time += 8;
    });
    scheduler.workScheduler.requestFrame(input, "input");
    scheduler.time += 16;
    scheduler.runNext();
    expect(input).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(scheduler.pendingCount).toBe(1);
    renderer.setViewport({ height: 100, left: 0, top: 60, width: 100 });
    expect(cancel).toHaveBeenCalled();
    prepare.mockImplementationOnce(() => true);
    scheduler.time += 16;
    scheduler.runNext();
    expect(prepare).toHaveBeenCalledTimes(2);
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
    expect(prepare).toHaveBeenCalledTimes(2);
  } finally {
    prepare.mockRestore();
  }
});

it("reports actual autonomous cache growth and immediately cancels its successor on memory pressure", () => {
  const { store } = fixture(50, 330);
  const scheduler = new FakeScheduler();
  let grownBytes = 0;
  let grownEntries = 0;
  const usage = vi.fn(() => {
    grownEntries = renderer.instrumentation().pathCacheEntries;
    if (grownEntries === 0) return;
    grownBytes = renderer.memoryUsage().pathCacheBytes;
    renderer.setActiveDocumentMemoryPressure(true);
  });
  const { renderer } = createSceneFixture(
    NAVIGATION_PAGE,
    store,
    { height: 100, left: 0, top: 0, width: 100 },
    { onResourceUsageChanged: usage },
    scheduler,
  );
  scheduler.runAll();
  usage.mockClear();
  const prepare = vi.spyOn(NavigationPathPreparation.prototype, "prepare");
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked via call with the actual cache receiver.
  const original = ScenePathCache.prototype.startPreparation;
  const builds = vi.spyOn(ScenePathCache.prototype, "startPreparation");
  builds.mockImplementation(function (this: ScenePathCache, stroke, pressure) {
    const job = original.call(this, stroke, pressure);
    const advance = job.step.bind(job);
    vi.spyOn(job, "step").mockImplementation((deadline, now) => {
      const complete = advance(deadline, now);
      if (complete) scheduler.time += 8;
      return complete;
    });
    return job;
  });
  try {
    prepare.mockImplementationOnce(() => true);
    renderer.setViewport({ height: 100, left: 0, top: 50, width: 100 });
    scheduler.runNext();
    usage.mockClear();
    const before = renderer.memoryUsage().pathCacheBytes;
    scheduler.time += 16;
    scheduler.runNext();
    expect(builds).toHaveBeenCalledOnce();
    expect(usage).toHaveBeenCalledOnce();
    expect(grownEntries).toBe(1);
    expect(grownBytes).toBeGreaterThan(before);
    expect(renderer.instrumentation().pathCacheEntries).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
  } finally {
    prepare.mockRestore();
    builds.mockRestore();
    renderer.destroy();
  }
});
