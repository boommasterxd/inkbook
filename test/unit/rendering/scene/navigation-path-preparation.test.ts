import { expect, it, vi } from "vitest";
import { UniformSpatialIndex } from "../../../../src/domain/spatial";
import type { Bounds } from "../../../../src/domain/geometry/primitives";
import { NavigationPathPreparation } from "../../../../src/rendering/scene/navigation-path-preparation";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../src/rendering/scene/constants";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import type { SceneStorePort } from "../../../../src/rendering/scene/types";
import { createSceneRecord, createSceneFixture } from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { FakeScheduler, fakeRectangleRecord } from "./fakes";
import type {
  PreparedScenePathEntry,
  ScenePathPreparationObserver,
} from "../../../../src/domain/geometry/prepared-scene-paths";
import { MAX_PREPARED_SCENE_PATH_BYTES } from "../../../../src/domain/geometry/prepared-scene-paths";

function remoteFixture(y = 120) {
  const local = fixture(50, y);
  let observer: ScenePathPreparationObserver | undefined;
  let signal!: AbortSignal;
  let resolve!: (paths: readonly PreparedScenePathEntry[] | undefined) => void;
  const request = vi.fn(
    (
      _ids: readonly string[],
      cancellation: AbortSignal,
      progress?: ScenePathPreparationObserver,
    ) => {
      signal = cancellation;
      observer = progress;
      return new Promise<readonly PreparedScenePathEntry[] | undefined>((ready) => {
        resolve = ready;
      });
    },
  );
  local.store.prepareScenePaths = request;
  const ready = vi.fn();
  const preparation = new NavigationPathPreparation(local.store, local.cache, ready);
  const path = { id: local.record.id, parts: [{ d: "M50 120L51 120", paint: "stroke" as const }] };
  return {
    ...local,
    preparation,
    request,
    ready,
    path,
    observer: () => observer!,
    signal: () => signal,
    resolve: (paths: readonly PreparedScenePathEntry[] | undefined) => resolve(paths),
  };
}

function startRemoteFixture() {
  const remote = remoteFixture();
  remote.preparation.setTarget(PRIORITY, BOUNDS);
  remote.preparation.prepare(Infinity, () => 0);
  return remote;
}

async function assertObsoleteDeliveryRejected(remote: ReturnType<typeof remoteFixture>) {
  expect(remote.signal().aborted).toBe(true);
  remote.observer().onProgress([remote.path]);
  remote.resolve([remote.path]);
  await Promise.resolve();
  expect(remote.ready).not.toHaveBeenCalled();
  expect(remote.cache.has(remote.record.id, 1)).toBe(false);
}

function createRemoteScene(remote: ReturnType<typeof remoteFixture>) {
  return createSceneFixture(NAVIGATION_PAGE, remote.store, {
    height: 100,
    left: 0,
    top: 0,
    width: 100,
  });
}

it("leaves no scene frame queued while a directional worker batch is pending and wakes for cache adoption", async () => {
  const remote = remoteFixture(550);
  const { renderer, scheduler } = createRemoteScene(remote);
  try {
    scheduler.runAll();
    renderer.setViewport({ height: 100, left: 0, top: 50, width: 100 });
    scheduler.runAll();
    expect(remote.request).toHaveBeenCalledOnce();
    expect(scheduler.pendingCount).toBe(0);
    remote.observer().onProgress([remote.path]);
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runAll();
    expect(renderer.instrumentation().pathCacheEntries).toBe(1);
    expect(scheduler.pendingCount).toBe(0);
    remote.resolve([]);
    await Promise.resolve();
    scheduler.runAll();
  } finally {
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("warms remote contours without polling or local geometry work and adopts within the original deadline", async () => {
  const remote = remoteFixture();
  const builds = vi.spyOn(remote.cache, "startPreparation");
  remote.preparation.setTarget({ viewport: BOUNDS, direction: { x: 0, y: 1 } }, BOUNDS);
  expect(remote.preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(remote.request).toHaveBeenCalledOnce();
  expect(remote.observer().speculative).toBe(true);
  expect(remote.preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(remote.ready).not.toHaveBeenCalled();
  expect(remote.preparation.hasReadyPaths).toBe(false);
  remote.observer().onProgress([remote.path]);
  expect(remote.ready).toHaveBeenCalledOnce();
  expect(remote.preparation.hasReadyPaths).toBe(true);
  expect(remote.preparation.prepare(0, () => 0)).toBe(true);
  expect(remote.cache.has(remote.record.id, 1)).toBe(false);
  expect(remote.preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(remote.cache.take(remote.record.id, 1)).toEqual(remote.path.parts);
  expect(remote.preparation.hasReadyPaths).toBe(false);
  expect(builds).not.toHaveBeenCalled();
  remote.resolve([]);
  await Promise.resolve();
  remote.preparation.prepare(Infinity, () => 0);
  expect(remote.preparation.memoryUsage()).toBe(0);
  remote.preparation.cancel();
  remote.preparation.setTarget({ viewport: BOUNDS, direction: { x: 0, y: 1 } }, BOUNDS);
  remote.preparation.prepare(Infinity, () => 0);
  expect(remote.request).toHaveBeenCalledOnce();
});

it.each(["pause", "reverse", "cancel"] as const)(
  "rejects obsolete remote progress after %s",
  async (action) => {
    const remote = startRemoteFixture();
    if (action === "reverse")
      remote.preparation.setTarget({ ...PRIORITY, direction: { x: 0, y: -1 } }, BOUNDS);
    else remote.preparation[action]();
    await assertObsoleteDeliveryRejected(remote);
    expect(remote.preparation.memoryUsage()).toBe(0);
  },
);

it("rejects outdated geometry versions and falls back locally when the remote executor is unavailable", async () => {
  const remote = remoteFixture();
  remote.preparation.setTarget({ viewport: BOUNDS, direction: { x: 0, y: 1 } }, BOUNDS);
  remote.preparation.prepare(Infinity, () => 0);
  remote.store.get = () => ({ ...remote.record, geometryVersion: 2 });
  remote.observer().onProgress([remote.path]);
  remote.preparation.prepare(Infinity, () => 0);
  expect(remote.cache.has(remote.record.id, 1)).toBe(false);
  remote.resolve(undefined);
  await Promise.resolve();
  expect(remote.preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(remote.cache.has(remote.record.id, 2)).toBe(true);
  expect(remote.request).toHaveBeenCalledOnce();
  remote.preparation.cancel();
  expect(remote.preparation.memoryUsage()).toBe(0);
});

it("falls back after a synchronously failing preparation port without retaining its reservation", () => {
  const remote = remoteFixture();
  remote.request.mockImplementation(() => {
    throw new Error("unavailable");
  });
  remote.preparation.setTarget({ viewport: BOUNDS, direction: { x: 0, y: 1 } }, BOUNDS);
  expect(remote.preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(remote.preparation.memoryUsage()).toBe(0);
  expect(remote.preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(remote.cache.has(remote.record.id, 1)).toBe(true);
  expect(remote.request).toHaveBeenCalledOnce();
});

it("releases an oversized remote delivery and preserves the bounded local fallback", () => {
  const remote = remoteFixture();
  remote.preparation.setTarget({ viewport: BOUNDS, direction: { x: 0, y: 1 } }, BOUNDS);
  remote.preparation.prepare(Infinity, () => 0);
  remote.observer().onProgress([
    {
      id: remote.path.id,
      parts: [{ paint: "stroke", d: "0".repeat(MAX_PREPARED_SCENE_PATH_BYTES / 2) }],
    },
  ]);
  expect(remote.signal().aborted).toBe(true);
  expect(remote.preparation.memoryUsage()).toBe(0);
  expect(remote.cache.has(remote.record.id, 1)).toBe(false);
  remote.preparation.prepare(Infinity, () => 0);
  expect(remote.cache.has(remote.record.id, 1)).toBe(true);
  expect(remote.request).toHaveBeenCalledOnce();
});

const BOUNDS = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const PRIORITY = { viewport: BOUNDS, direction: { x: 0, y: 1 } };

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
  const { store } = fixture(50, 550);
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
  const { store } = fixture(50, 550);
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
  const { store } = fixture(50, 550);
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

it("retains overlapping remote work and buffered contours as they enter the mounting envelope", async () => {
  const remote = remoteFixture();
  remote.preparation.setTarget(PRIORITY, BOUNDS);
  remote.preparation.prepare(Infinity, () => 0);
  const retarget = vi.fn();
  remote.observer().setRetarget(retarget);
  retarget.mockClear();
  remote.preparation.setTarget(PRIORITY, { ...BOUNDS, minY: 5, maxY: 105 });
  expect(remote.signal().aborted).toBe(false);
  expect(retarget).not.toHaveBeenCalled();
  remote.observer().onProgress([remote.path]);
  remote.preparation.setTarget(PRIORITY, { ...BOUNDS, minY: 30, maxY: 130 });
  expect(remote.signal().aborted).toBe(false);
  expect(retarget).not.toHaveBeenCalled();
  remote.resolve(undefined);
  await Promise.resolve();
  expect(remote.signal().aborted).toBe(true);
  expect(remote.preparation.adoptReady(0, () => 0)).toBe(true);
  expect(remote.cache.has(remote.record.id, 1)).toBe(false);
  expect(remote.preparation.adoptReady(Infinity, () => 0)).toBe(false);
  expect(remote.cache.has(remote.record.id, 1)).toBe(true);
  expect(remote.request).toHaveBeenCalledOnce();
  expect(remote.preparation.prepare(Infinity, () => 0)).toBe(false);
  remote.preparation.cancel();
  expect(remote.preparation.memoryUsage()).toBe(0);
});

it.each(["jump", "geometry"] as const)(
  "releases remote reservations made obsolete by a %s retarget",
  async (cause) => {
    const remote = startRemoteFixture();
    if (cause === "geometry") remote.store.get = () => ({ ...remote.record, geometryVersion: 2 });
    const offset = cause === "jump" ? 1_000 : 5;
    remote.preparation.setTarget(PRIORITY, {
      ...BOUNDS,
      minY: offset,
      maxY: 100 + offset,
    });
    await assertObsoleteDeliveryRejected(remote);
    remote.preparation.cancel();
    expect(remote.preparation.memoryUsage()).toBe(0);
  },
);

it("starts the leading worker reserve while only overscan publication is unfinished", () => {
  const remote = remoteFixture(600);
  const records = new Map([[remote.record.id, remote.record]]);
  for (let rank = 0; rank < 600; rank++) {
    const record = fakeRectangleRecord(`overscan-${rank}`, rank + 1, 20, 450);
    records.set(record.id, record);
    remote.index.insert(record.id, record.bounds);
  }
  remote.store.get = (id) => records.get(id);
  const { renderer, scheduler } = createRemoteScene(remote);
  try {
    scheduler.runAll();
    renderer.setViewport({ height: 100, left: 0, top: 100, width: 100 });
    scheduler.runNext();
    expect(renderer.mountedCount).toBe(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    expect(scheduler.pendingCount).toBeGreaterThan(0);
    expect(remote.request).toHaveBeenCalledOnce();
    expect(remote.request.mock.calls[0]![0]).toEqual([remote.record.id]);
    expect(remote.observer().navigationReserve).toBe(true);
  } finally {
    renderer.destroy();
  }
  expect(remote.signal().aborted).toBe(true);
  expect(scheduler.pendingCount).toBe(0);
});
