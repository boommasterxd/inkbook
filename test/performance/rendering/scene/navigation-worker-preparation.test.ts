import { expect, it, vi } from "vitest";
import { UniformSpatialIndex } from "../../../../src/domain/spatial";
import { MAX_PREPARED_SCENE_PATH_BYTES } from "../../../../src/domain/geometry/prepared-scene-paths";
import { NavigationPathPreparation } from "../../../../src/rendering/scene/navigation-path-preparation";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import { SessionScenePaths } from "../../../../src/obsidian/embeds/session-scene-paths";
import type { SceneStorePort } from "../../../../src/rendering/scene/types";
import {
  beginNavigationPathRequest,
  createSceneRecord,
  observeIndexedSceneQueries,
} from "../../../fixtures/rendering/scene";
import {
  createWorkerBridgeClient,
  createWorkerBridgeHarness,
} from "../../../fixtures/persistence/worker-bridge";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";

const BOUNDS = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const PRIORITY = { viewport: BOUNDS, direction: { x: 0, y: 1 } };

async function workerFixture(bridge: boolean) {
  const elements = Array.from({ length: 10_000 }, (_, index) => {
    const y = index < 300 ? 120 : 10_000;
    return {
      ...createTestStroke(),
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      pivot: { x: 20, y },
      points: [20, y, 0.5, 21, y, 1],
    };
  });
  const records = new Map(
    elements.map((element, rank) => [element.id, createSceneRecord(element, rank)]),
  );
  const index = new UniformSpatialIndex<string>();
  index.insertMany([...records.values()].map(({ id, bounds }) => ({ id, bounds })));
  const harness = createWorkerBridgeHarness();
  const port = bridge ? createWorkerBridgeClient(harness.clientEndpoint) : harness.runtime;
  const retarget = vi.spyOn(port, "retargetScenePreparation");
  const identity = {
    sessionId: "session-a",
    workerEpoch: 1,
    operationId: 0,
    purpose: "background" as const,
  };
  await port.execute({
    baseModelRevision: null,
    identity,
    modelRevision: 0,
    snapshot: createWorkerSnapshot(elements),
    type: "model-sync-full",
  });
  const session = new SessionScenePaths({
    disposed: () => false,
    executor: () => port,
    revision: () => 0,
    sessionId: "session-a",
    synchronize: () => Promise.resolve(true),
    workerEpoch: () => 1,
  });
  let settled: Promise<unknown> | undefined;
  const { query, work } = observeIndexedSceneQueries(index);
  const prepare = vi.fn<NonNullable<SceneStorePort["prepareScenePaths"]>>((...args) => {
    const pending = session.prepare(...args);
    settled = pending;
    return pending;
  });
  const store: SceneStorePort = {
    get: (id) => records.get(id),
    query: () => {
      throw new Error("Directional work must use the real index.");
    },
    beginQuery: (bounds) => index.beginQuery(bounds),
    prepareScenePaths: prepare,
  };
  const cache = new ScenePathCache();
  const ready = vi.fn();
  const preparation = new NavigationPathPreparation(store, cache, ready);
  return {
    ...harness,
    store,
    records,
    retarget,
    cache,
    preparation,
    prepare,
    ready,
    settle: () => settled,
    indexedWork: () => work.indexedVisits,
    reverse: () => {
      preparation.setTarget({ ...PRIORITY, direction: { x: 0, y: -1 } }, BOUNDS);
      preparation.prepare(Infinity, () => 0);
    },
    close: () => {
      preparation.cancel();
      cache.release();
      query.mockRestore();
      port.terminate();
      harness.detach();
    },
  };
}

it.each([false, true])(
  "bounds lean directional worker preparation and reuses warm versions, bridge=%s",
  async (bridge) => {
    const fixture = await workerFixture(bridge);
    const local = vi.spyOn(fixture.cache, "startPreparation");
    try {
      const [ids, , observer] = beginNavigationPathRequest(fixture, PRIORITY, BOUNDS);
      expect(ids).toHaveLength(256);
      expect(observer?.speculative).toBe(true);
      expect(observer?.navigationReserve).toBe(true);
      expect(observer?.maxBytes).toBe(MAX_PREPARED_SCENE_PATH_BYTES);
      expect(fixture.indexedWork()).toBeLessThanOrEqual(270);
      expect(fixture.preparation.memoryUsage()).toBeLessThanOrEqual(
        MAX_PREPARED_SCENE_PATH_BYTES + 256 * 128 + 512 + 256 * 32,
      );
      expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
      await fixture.settle();
      expect(fixture.ready).toHaveBeenCalled();
      expect(fixture.preparation.prepare(0, () => 0)).toBe(true);
      expect(fixture.cache.statistics().entries).toBe(0);
      fixture.preparation.prepare(Infinity, () => 0);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(256);
      expect(fixture.runtime.instrumentation.fragmentBuilds).toBe(0);
      expect(local).not.toHaveBeenCalled();
      expect(fixture.cache.statistics().entries).toBe(256);
      expect(fixture.cache.statistics().bytes).toBeLessThanOrEqual(25 * 1024 * 1024);
      expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
      expect(fixture.prepare).toHaveBeenCalledTimes(2);
      expect(fixture.prepare.mock.calls[1]![0]).toHaveLength(44);
      await fixture.settle();
      fixture.preparation.prepare(Infinity, () => 0);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(300);
      expect(fixture.cache.statistics().entries).toBe(300);
      expect(fixture.indexedWork()).toBeLessThanOrEqual(314);
      expect(fixture.preparation.memoryUsage()).toBe(0);
      fixture.preparation.cancel();
      fixture.preparation.setTarget(PRIORITY, BOUNDS);
      fixture.preparation.prepare(Infinity, () => 0);
      expect(fixture.prepare).toHaveBeenCalledTimes(2);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(300);
      fixture.reverse();
      expect(fixture.prepare).toHaveBeenCalledTimes(2);
    } finally {
      fixture.close();
    }
    expect(fixture.preparation.memoryUsage()).toBe(0);
    expect(fixture.cache.statistics().bytes).toBe(0);
    expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
  },
);

it("cancels the reserved remote payload before retargeting and rejects late completed contours", async () => {
  const fixture = await workerFixture(false);
  try {
    fixture.preparation.setTarget(PRIORITY, BOUNDS);
    fixture.preparation.prepare(Infinity, () => 0);
    const [, signal] = fixture.prepare.mock.calls[0]!;
    fixture.preparation.pause();
    expect(signal.aborted).toBe(true);
    expect(fixture.preparation.memoryUsage()).toBe(0);
    await fixture.settle();
    expect(fixture.cache.statistics().entries).toBe(0);
    expect(fixture.ready).not.toHaveBeenCalled();
    fixture.reverse();
    expect(fixture.prepare).toHaveBeenCalledOnce();
  } finally {
    fixture.close();
  }
  expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
});

it("sends retarget messages only for removed reservations in a full directional worker batch", async () => {
  const fixture = await workerFixture(true);
  const reads = vi.spyOn(fixture.store, "get");
  try {
    const [ids, signal] = beginNavigationPathRequest(fixture, PRIORITY, BOUNDS);
    expect(ids).toHaveLength(256);
    // Synchronization installs the transport handler before the pending worker finishes.
    await Promise.resolve();
    fixture.retarget.mockClear();
    reads.mockClear();
    for (const offset of [1, 2, 3]) {
      fixture.preparation.setTarget(PRIORITY, { ...BOUNDS, minY: offset, maxY: 100 + offset });
    }
    expect(reads).toHaveBeenCalledTimes(3 * ids.length);
    expect(fixture.retarget).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(false);
    const stale = fixture.records.get(ids[0]!)!;
    fixture.records.set(stale.id, { ...stale, geometryVersion: 2 });
    fixture.records.delete(ids[1]!);
    const departed = fixture.records.get(ids[2]!)!;
    fixture.records.set(departed.id, {
      ...departed,
      bounds: { minX: 0, maxX: 10, minY: 1_000, maxY: 1_010 },
    });
    reads.mockClear();
    fixture.preparation.setTarget(PRIORITY, { ...BOUNDS, minY: 4, maxY: 104 });
    expect(reads).toHaveBeenCalledTimes(ids.length);
    expect(fixture.retarget).toHaveBeenCalledOnce();
    expect(fixture.retarget.mock.calls[0]![1]).toEqual(ids.slice(3));
    await fixture.settle();
    fixture.preparation.prepare(Infinity, () => 0);
    expect(fixture.cache.statistics().entries).toBe(ids.length - 3);
    expect(fixture.cache.has(stale.id, 1)).toBe(false);
    expect(fixture.cache.has(departed.id, 1)).toBe(false);
    fixture.preparation.cancel();
    expect(fixture.preparation.memoryUsage()).toBe(0);
  } finally {
    fixture.close();
  }
  expect(fixture.cache.statistics().bytes).toBe(0);
  expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
});
