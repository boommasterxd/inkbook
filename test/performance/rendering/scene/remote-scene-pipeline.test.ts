import { expect, it, vi } from "vitest";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/document-runtime";
import {
  MAX_PREPARED_SCENE_PATH_BYTES,
  MAX_PREPARED_SCENE_PATH_IDS,
} from "../../../../src/domain/geometry/prepared-scene-paths";
import type { SvgSceneRenderer } from "../../../../src/rendering/scene/scene-renderer";
import type { SceneStorePort } from "../../../../src/rendering/scene/types";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { observePointReads } from "../../../fixtures/rendering/point-reads";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";
import { FakeSceneStore, fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";

it("refills the real worker before the last cached roots publish and reuses 945 cold contours", async () => {
  const identity = { sessionId: "session-a", workerEpoch: 1 };
  const runtime = new DocumentWorkerRuntime(identity);
  const store: FakeSceneStore & Pick<SceneStorePort, "prepareScenePaths"> = new FakeSceneStore();
  const base = createTestStroke();
  const elements = Array.from({ length: 945 }, (_, rank) => ({
    ...base,
    id: `00000000-0000-4000-8000-${String(rank).padStart(12, "0")}`,
    pivot: { x: 505, y: 20 },
    points: [500, 20, 0.5, 510, 20, 1],
    style: { ...base.style, pressureEnabled: false },
  }));
  expect(
    await runtime.execute({
      baseModelRevision: null,
      identity: { ...identity, operationId: 1, purpose: "background" },
      modelRevision: 0,
      snapshot: createWorkerSnapshot(elements),
      type: "model-sync-full",
    }),
  ).toMatchObject({ type: "model-sync-success" });
  const warm = fakeRectangleRecord("warm", 0, 20);
  store.records.set(warm.id, warm);
  let pointReads = 0;
  for (const [rank, original] of elements.entries()) {
    Object.freeze(original.points);
    const element = {
      ...original,
      points: observePointReads(original.points, () => pointReads++),
    };
    store.records.set(element.id, {
      id: element.id,
      element,
      rank: rank + 1,
      band: "content",
      geometryVersion: 0,
      paintVersion: 0,
      bounds: { minX: 500, minY: 20, maxX: 510, maxY: 21 },
    });
  }
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, {
    height: 100,
    width: 100,
    left: 0,
    top: 0,
  });
  const pipeline = observePipeline(runtime, renderer, identity);
  const { requests } = pipeline;
  // The first two requests fill the 256-ID pool; later refill starts at half-pool space.
  const minimumRefill = MAX_PREPARED_SCENE_PATH_IDS / 2;
  const maximumRequests =
    2 + Math.ceil((elements.length - MAX_PREPARED_SCENE_PATH_IDS) / minimumRefill);
  store.prepareScenePaths = pipeline.prepareScenePaths;
  const get = vi.spyOn(store, "get");
  try {
    scheduler.runAll();
    renderer.setViewport({ height: 100, width: 100, left: 500, top: 0 });
    scheduler.runAll();
    for (let pass = 0; renderer.mountedCount < 945 && pass < 20; pass++) {
      await pipeline.settle();
      await Promise.resolve();
      scheduler.runAll();
    }
    expect(renderer.mountedCount).toBe(945);
    expect(requests[0]!.count).toBe(1);
    expect(requests[1]!.count).toBe(MAX_PREPARED_SCENE_PATH_IDS - 1);
    expect(requests.slice(1, -1).every((request) => request.count >= minimumRefill)).toBe(true);
    expect(requests.length).toBeLessThanOrEqual(maximumRequests);
    expect(requests.reduce((count, request) => count + request.count, 0)).toBe(945);
    expect(
      requests
        .slice(2)
        .some(
          (request, index) =>
            request.mounted <
            requests.slice(0, index + 2).reduce((count, item) => count + item.count, 0),
        ),
    ).toBe(true);
    expect(runtime.instrumentation.shapeBuilds).toBe(945);
    expect(pointReads).toBe(0);
    expect(get.mock.calls.length).toBeLessThanOrEqual(945 * 12);
    const builds = renderer.instrumentation().geometryBuilds;
    renderer.setViewport({ height: 100, width: 100, left: 0, top: 0 });
    scheduler.runAll();
    renderer.setViewport({ height: 100, width: 100, left: 500, top: 0 });
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(945);
    expect(requests.length).toBeLessThanOrEqual(maximumRequests);
    expect(renderer.instrumentation().geometryBuilds).toBe(builds);
    expect(pointReads).toBe(0);
    expect(pipeline.active()).toBe(0);
  } finally {
    get.mockRestore();
    renderer.destroy();
    runtime.terminate();
  }
  expect(scheduler.pendingCount).toBe(0);
  expect(runtime.instrumentation.shapeCacheBytes).toBe(0);
});

function observePipeline(
  runtime: DocumentWorkerRuntime,
  renderer: Pick<SvgSceneRenderer, "mountedCount">,
  identity: { sessionId: string; workerEpoch: number },
) {
  let settle: Promise<unknown> | undefined;
  let active = 0;
  const requests: { count: number; mounted: number }[] = [];
  const prepareScenePaths: NonNullable<SceneStorePort["prepareScenePaths"]> = async (
    ids,
    signal,
    observer,
  ) => {
    expect(++active).toBe(1);
    requests.push({ count: ids.length, mounted: renderer.mountedCount });
    expect(ids.length).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_IDS);
    expect(observer!.maxBytes).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_BYTES);
    const operation = {
      ...identity,
      operationId: requests.length + 1,
      purpose: "background" as const,
    };
    observer!.setRetarget((retained) => runtime.retargetScenePreparation(operation, retained));
    const abort = () => runtime.cancelScenePreparation(operation);
    signal.addEventListener("abort", abort, { once: true });
    const pending = runtime.execute(
      {
        basisRevision: 0,
        identity: operation,
        ids,
        ...(observer!.visibleCount === undefined ? {} : { visibleCount: observer!.visibleCount }),
        ...(observer!.maxBytes === undefined ? {} : { maxBytes: observer!.maxBytes }),
        streamProgress: true,
        type: "prepare-scene-paths",
      },
      {
        unlockBatch: () => undefined,
        scenePaths: (batch) => observer!.onProgress(batch.paths),
      },
    );
    settle = pending;
    try {
      const result = await pending;
      if (result.type !== "prepare-scene-paths-success") throw new Error("Contour request failed.");
      return result.paths;
    } finally {
      active--;
      signal.removeEventListener("abort", abort);
    }
  };
  return { prepareScenePaths, requests, settle: () => settle, active: () => active };
}
