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
    fixture.preparation.pause();
    expect(remote.signal().aborted).toBe(true);
    expect(fixture.preparation.memoryUsage()).toBeLessThanOrEqual(
      MAX_PREPARED_SCENE_PATH_IDS * 128 + 128,
    );
    fixture.store.prepareScenePaths = fixture.prepare;
    await completeDocumentPaths(fixture);
    expect(fixture.work.orderReads).toBe(count);
    expect(fixture.work.builds).toBe(count);
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

it("does no file work while admission is closed and resumes a 10,006-stroke cursor without rescanning", async () => {
  const count = 10_006;
  const fixture = createDocumentPathFixture(count);
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
    scene.renderer.setDocumentPrewarmEnabled(false);
    expect(remote.signal().aborted).toBe(true);
    const requests = vi.mocked(fixture.store.prepareScenePaths!).mock.calls.length;
    scene.renderer.setScheme("dark");
    scene.renderer.invalidateLayout(true);
    scene.scheduler.runAll();
    expect(scene.renderer.hasPendingSceneCommit).toBe(false);
    expect(fixture.work.orderReads).toBe(MAX_PREPARED_SCENE_PATH_IDS);
    expect(fixture.work.builds).toBe(0);
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
