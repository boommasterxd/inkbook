import { expect, it, vi } from "vitest";
import {
  MAX_PREPARED_SCENE_PATH_BYTES,
  MAX_PREPARED_SCENE_PATH_IDS,
  preparedScenePathBytes,
} from "../../../../src/domain/geometry/prepared-scene-paths";
import type { ScenePathPreparation } from "../../../../src/domain/geometry/prepared-scene-paths";
import { DocumentPathPreparation } from "../../../../src/rendering/scene/document-path-preparation";
import { SessionScenePaths } from "../../../../src/obsidian/embeds/session-scene-paths";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import {
  completeDocumentPaths,
  createDocumentPathFixture,
  deferDocumentPaths,
  pauseDocumentPaths,
} from "../../../fixtures/rendering/document-path-preparation";
import { createWorkerBridgeHarness } from "../../../fixtures/persistence/worker-bridge";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";

it("warms missing contours in a 10,006-stroke document through bounded worker batches without serialization", async () => {
  const count = 10_006;
  const fixture = createDocumentPathFixture(count);
  const harness = createWorkerBridgeHarness();
  const identity = {
    operationId: 1,
    purpose: "background" as const,
    sessionId: "session-a",
    workerEpoch: 1,
  };
  let pending: ReturnType<ScenePathPreparation> | undefined;
  let receivedBytes = 0;
  const session = new SessionScenePaths({
    disposed: () => false,
    executor: () => harness.runtime,
    revision: () => 0,
    sessionId: "session-a",
    synchronize: () => Promise.resolve(true),
    workerEpoch: () => 1,
  });
  const prepare = vi.fn<ScenePathPreparation>((ids, signal, observer) => {
    expect(ids.length).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_IDS);
    expect(observer?.maxBytes).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_BYTES);
    expect(observer?.speculative).toBe(true);
    expect(observer?.navigationReserve).toBe(false);
    pending = session.prepare(ids, signal, {
      ...observer!,
      onProgress: (paths) => {
        receivedBytes += paths.reduce(
          (bytes, path) => bytes + preparedScenePathBytes(path.id, path.parts),
          0,
        );
        observer!.onProgress(paths);
      },
    });
    return pending;
  });
  fixture.store.prepareScenePaths = prepare;
  try {
    await harness.runtime.execute({
      baseModelRevision: null,
      identity,
      modelRevision: 0,
      snapshot: createWorkerSnapshot(fixture.elements),
      type: "model-sync-full",
    });
    for (const element of fixture.elements.slice(0, MAX_PREPARED_SCENE_PATH_IDS)) {
      const record = fixture.store.get(element.id)!;
      fixture.cache.retain(element.id, record.geometryVersion, buildElementPathParts(element));
    }
    let frames = 0;
    while (fixture.preparation.needsWork && frames++ < 100) {
      fixture.preparation.prepare(Infinity, () => 0);
      expect(fixture.preparation.memoryUsage()).toBeLessThanOrEqual(
        MAX_PREPARED_SCENE_PATH_BYTES + MAX_PREPARED_SCENE_PATH_IDS * 128 + 128,
      );
      await pending;
    }
    expect(fixture.preparation.needsWork).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(Math.ceil((count - 256) / 256));
    expect(fixture.work.orderReads).toBe(count);
    expect(fixture.domain.instrumentation.snapshotMaterializations).toBe(0);
    expect(fixture.domain.instrumentation.bandScans).toBe(0);
    expect(harness.runtime.instrumentation.shapeBuilds).toBe(count - 256);
    expect(harness.runtime.instrumentation.fragmentBuilds).toBe(0);
    expect(receivedBytes).toBeGreaterThan(0);
    expect(fixture.cache.statistics().entries).toBe(count);
    expect(fixture.cache.statistics().bytes).toBeLessThanOrEqual(25 * 1024 * 1024);
    expect(fixture.cache.statistics().evictions).toBe(0);
    const adopted = fixture.store.get(fixture.elements[count - 1]!.id)!;
    const contour = fixture.cache.take(adopted.id, adopted.geometryVersion);
    expect(contour).toBeDefined();
    expect(fixture.cache.read(adopted.element)).toBe(contour);
    expect(
      fixture.store.pressureGeometry(adopted.id, adopted.geometryVersion).readPath?.(),
    ).toEqual(contour);
    const requests = prepare.mock.calls.length;
    const reused = new DocumentPathPreparation(fixture.store, fixture.cache, vi.fn());
    expect(reused.prepare(Infinity, () => 0)).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(requests);
    expect(fixture.work.orderReads).toBe(count * 2);
    reused.release();
  } finally {
    fixture.preparation.release();
    fixture.cache.release();
    fixture.store.release();
    harness.runtime.terminate();
    harness.detach();
  }
  expect(fixture.preparation.memoryUsage()).toBe(0);
  expect(fixture.cache.statistics().bytes).toBe(0);
  expect(harness.runtime.instrumentation.shapeCacheBytes).toBe(0);
});

it("retains lazy progress across input interruption and rebuilds only changed geometry at file capacity", async () => {
  const count = 10_006;
  const fixture = createDocumentPathFixture(count);
  const remote = deferDocumentPaths(fixture);
  try {
    fixture.preparation.prepare(Infinity, () => 0);
    expect(fixture.work.orderReads).toBe(MAX_PREPARED_SCENE_PATH_IDS);
    const readyIds = fixture.elements.slice(0, 64).map(({ id }) => id);
    const delivered = fixture.build(readyIds);
    remote.observer().onProgress(delivered);
    const adopt = pauseDocumentPaths(fixture, remote.signal());
    expect(fixture.preparation.memoryUsage()).toBeLessThanOrEqual(
      MAX_PREPARED_SCENE_PATH_BYTES + MAX_PREPARED_SCENE_PATH_IDS * 128 + 128,
    );
    expect(fixture.preparation.prepare(0, () => 0)).toBe(true);
    expect(adopt).not.toHaveBeenCalled();
    const foreground = fixture.store.get(readyIds[0]!)!;
    const get = vi.spyOn(fixture.store, "get");
    const transferred = fixture.preparation.takeReady(foreground);
    expect(get).toHaveBeenCalledOnce();
    expect(transferred).toBe(delivered[0]!.parts);
    expect(fixture.work.builds).toBe(readyIds.length);
    fixture.cache.retain(foreground.id, foreground.geometryVersion, transferred!);
    get.mockRestore();
    fixture.store.prepareScenePaths = fixture.prepare;
    await completeDocumentPaths(fixture);
    expect(fixture.work.orderReads).toBe(count);
    expect(fixture.work.builds).toBe(count);
    expect(
      fixture.prepare.mock.calls.flatMap(([ids]) => ids).filter((id) => readyIds.includes(id)),
    ).toEqual([]);
    expect(fixture.prepare.mock.calls.every(([ids]) => ids.length <= 256)).toBe(true);
    const changed = fixture.elements[500]!;
    fixture.domain.replace(changed.id, {
      ...changed,
      style: { ...changed.style, width: 4 },
    });
    fixture.preparation.invalidate({ affected: [{ id: changed.id, domains: ["geometry"] }] });
    const previousRequests = fixture.prepare.mock.calls.length;
    await completeDocumentPaths(fixture);
    expect(fixture.work.builds).toBe(count + 1);
    expect(fixture.work.orderReads).toBe(count);
    expect(fixture.prepare.mock.calls.slice(previousRequests).map(([ids]) => ids)).toEqual([
      [changed.id],
    ]);
    expect(fixture.cache.statistics().evictions).toBe(0);
    expect(fixture.domain.instrumentation.snapshotMaterializations).toBe(0);
    expect(fixture.domain.instrumentation.bandScans).toBe(0);
    expect(fixture.preparation.memoryUsage()).toBe(0);
  } finally {
    fixture.preparation.release();
    fixture.cache.release();
    fixture.store.release();
  }
  expect(fixture.preparation.memoryUsage()).toBe(0);
  expect(fixture.cache.statistics().bytes).toBe(0);
});

it("reuses current contour aliases after a 10,006-stroke version change without pressure ports or reads", () => {
  const fixture = createDocumentPathFixture(10_006);
  const records = fixture.elements.map(({ id }) => fixture.store.get(id)!);
  for (const record of records) {
    const parts = fixture.cache.build(record.element);
    fixture.cache.retain(record.id, record.geometryVersion, parts);
  }
  const pressure = vi.spyOn(fixture.store, "pressureGeometry");
  const read = vi.spyOn(fixture.cache, "read");
  const restored = new DocumentPathPreparation(fixture.store, fixture.cache, vi.fn());
  const repeat = new DocumentPathPreparation(fixture.store, fixture.cache, vi.fn());
  try {
    expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
    expect(pressure.mock.calls.length).toBe(0);
    expect(read.mock.calls.length).toBe(0);
    fixture.domain.replaceMany(
      records.map(({ element }) => ({
        ...element,
        offset: { x: 20, y: 0 },
        pivot: { x: element.pivot.x + 20, y: element.pivot.y },
      })),
    );
    for (const { id } of records) fixture.cache.invalidate(id);
    expect(restored.prepare(Infinity, () => 0)).toBe(false);
    expect(pressure).toHaveBeenCalledTimes(records.length);
    expect(read).toHaveBeenCalledTimes(records.length);
    for (const { id } of records)
      expect(fixture.cache.has(id, fixture.store.get(id)!.geometryVersion)).toBe(true);
    expect(repeat.prepare(Infinity, () => 0)).toBe(false);
    expect(pressure).toHaveBeenCalledTimes(records.length);
    expect(read).toHaveBeenCalledTimes(records.length);
    expect(fixture.work.orderReads).toBe(records.length * 3);
    expect(fixture.work.builds).toBe(0);
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.cache.statistics()).toMatchObject({ entries: records.length, evictions: 0 });
    expect(fixture.cache.cacheMemoryUsage()).toBeLessThanOrEqual(25 * 1024 * 1024);
    const changed = fixture.store.get(records[0]!.id)!.element;
    if (changed.kind !== "stroke") throw new Error("Expected a stroke.");
    fixture.domain.replace(changed.id, {
      ...changed,
      style: { ...changed.style, width: 4 },
    });
    fixture.cache.invalidate(changed.id);
    restored.invalidate({ affected: [{ id: changed.id, domains: ["geometry"] }] });
    restored.prepare(Infinity, () => 0);
    expect(fixture.prepare.mock.calls.map(([ids]) => ids)).toEqual([[changed.id]]);
    restored.pause();
    fixture.cache.setRetentionEnabled(false);
    fixture.cache.setRetentionEnabled(true);
    expect(fixture.cache.statistics().entries).toBe(0);
    expect(fixture.cache.cacheMemoryUsage()).toBe(0);
  } finally {
    pressure.mockRestore();
    read.mockRestore();
    fixture.preparation.release();
    restored.release();
    repeat.release();
    fixture.cache.release();
    fixture.store.release();
  }
  expect(restored.memoryUsage()).toBe(0);
});

it("does no file work while admission is closed and resumes a 10,006-stroke cursor without rescanning", async () => {
  const count = 10_006;
  const fixture = createDocumentPathFixture(count);
  const foreground = fixture.elements[0]!;
  fixture.domain.replace(foreground.id, {
    ...foreground,
    pivot: { x: 20, y: 2000 },
    points: [20, 2000, 0.5],
  });
  const remote = deferDocumentPaths(fixture);
  const scene = createSceneFixture(
    NAVIGATION_PAGE,
    fixture.store,
    { height: 1, left: 0, top: 20_000, width: 1 },
    { scrollPreloadMarginPx: 100 },
  );
  try {
    scene.scheduler.runAll();
    expect(fixture.work.orderReads).toBe(MAX_PREPARED_SCENE_PATH_IDS);
    remote.observer().onProgress(fixture.build([fixture.elements[0]!.id]));
    scene.renderer.setDocumentPrewarmEnabled(false);
    expect(remote.signal().aborted).toBe(true);
    const requests = vi.mocked(fixture.store.prepareScenePaths!).mock.calls.length;
    const before = scene.renderer.instrumentation();
    const get = vi.spyOn(fixture.store, "get");
    scene.renderer.setViewport({ height: 100, left: 0, top: 1990, width: 100 });
    scene.scheduler.runAll();
    expect(scene.renderer.mountedCount).toBe(1);
    expect(get.mock.calls.every(([id]) => id === fixture.elements[0]!.id)).toBe(true);
    expect(get.mock.calls.length).toBeLessThanOrEqual(32);
    get.mockRestore();
    const after = scene.renderer.instrumentation();
    expect(after.geometryBuilds).toBe(before.geometryBuilds);
    expect(after.domRootsPublished - before.domRootsPublished).toBe(1);
    expect(vi.mocked(fixture.store.prepareScenePaths!).mock.calls.length).toBe(requests);
    scene.renderer.setScheme("dark");
    scene.renderer.invalidateLayout(true);
    scene.scheduler.runAll();
    expect(scene.renderer.hasPendingSceneCommit).toBe(false);
    expect(fixture.work.orderReads).toBe(MAX_PREPARED_SCENE_PATH_IDS);
    expect(fixture.work.builds).toBe(1);
    expect(vi.mocked(fixture.store.prepareScenePaths!).mock.calls.length).toBe(requests);
    expect(scene.scheduler.pendingCount).toBe(0);
    fixture.store.prepareScenePaths = fixture.prepare;
    scene.renderer.setDocumentPrewarmEnabled(true);
    let frames = 0;
    while (scene.scheduler.pendingCount > 0 && frames++ < 100) {
      scene.scheduler.runAll();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(frames).toBeLessThan(100);
    expect(fixture.work.orderReads).toBe(count);
    expect(fixture.work.builds).toBe(count);
    expect(fixture.prepare.mock.calls.every(([ids]) => ids.length <= 256)).toBe(true);
    expect(scene.renderer.instrumentation().pathCacheEntries).toBe(count);
    expect(fixture.domain.instrumentation.snapshotMaterializations).toBe(0);
    expect(fixture.domain.instrumentation.bandScans).toBe(0);
    expect(scene.scheduler.pendingCount).toBe(0);
  } finally {
    scene.renderer.destroy();
    fixture.preparation.release();
    fixture.cache.release();
    fixture.store.release();
  }
  expect(scene.scheduler.pendingCount).toBe(0);
});
