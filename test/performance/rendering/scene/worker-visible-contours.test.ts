import { expect, it } from "vitest";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/document-runtime";
import {
  MAX_SCENE_PATH_BYTES,
  scenePathBytes,
} from "../../../../src/persistence/worker/runtime/scene-path-limits";
import { RemoteScenePaths } from "../../../../src/rendering/scene/remote-scene-paths";
import type { SceneElementRecord, SceneStorePort } from "../../../../src/rendering/scene/types";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";

it("prepares only three thousand visible contours of ten thousand in bounded worker batches", async () => {
  const identity = {
    operationId: 1,
    purpose: "background" as const,
    sessionId: "session-a",
    workerEpoch: 1,
  };
  const runtime = new DocumentWorkerRuntime(identity);
  const elements = Array.from({ length: 10_000 }, (_, index) => ({
    ...createTestStroke(),
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  }));
  await runtime.execute({
    baseModelRevision: null,
    identity,
    modelRevision: 0,
    snapshot: createWorkerSnapshot(elements),
    type: "model-sync-full",
  });
  const records = new Map(
    elements.map((element, rank) => [
      element.id,
      {
        band: "content" as const,
        bounds: { minX: 10, minY: 10, maxX: 20, maxY: 20 },
        element,
        geometryVersion: 0,
        id: element.id,
        paintVersion: 0,
        rank,
      },
    ]),
  );
  let requests = 0;
  let reads = 0;
  let published = 0;
  let settle: Promise<unknown> | undefined;
  const store: SceneStorePort = {
    get: (id) => {
      reads++;
      return records.get(id);
    },
    query: () => undefined,
    preparePressurePaths: async (ids) => {
      requests++;
      expect(ids.length).toBeLessThanOrEqual(256);
      expect(ids.every((id) => records.get(id)!.rank < 3000)).toBe(true);
      const pending = runtime.execute({
        basisRevision: 0,
        identity: { ...identity, operationId: requests },
        ids,
        type: "prepare-scene-paths",
      });
      settle = pending;
      const result = await pending;
      if (result.type !== "prepare-scene-paths-success") throw new Error("Preparation failed.");
      expect(
        result.paths.reduce((bytes, path) => bytes + scenePathBytes(path.id, path.d), 0),
      ).toBeLessThanOrEqual(MAX_SCENE_PATH_BYTES);
      return result.paths.map(({ id, d }) => ({ id, parts: [{ d, paint: "fill" }] }));
    },
  };
  const preparation = new RemoteScenePaths(store);
  for (let index = 0; index < 3000; index++) {
    const record = records.get(elements[index]!.id)!;
    const upcoming = function* (): Iterable<string> {
      for (let next = index + 1; next < 3000; next++) yield elements[next]!.id;
    };
    let path = preparation.read(record, upcoming);
    if (path === "pending") {
      await settle;
      await Promise.resolve();
      path = preparation.read(record, upcoming);
    }
    expect(Array.isArray(path)).toBe(true);
    published++;
    expect(preparation.memoryUsage()).toBeLessThanOrEqual(MAX_SCENE_PATH_BYTES + 256 * 128);
  }
  expect(published).toBe(3000);
  expect(requests).toBe(Math.ceil(3000 / 256));
  expect(reads).toBeLessThanOrEqual(3000);
  expect(runtime.instrumentation.shapeBuilds).toBe(3000);
  preparation.cancel();
  expect(preparation.memoryUsage()).toBe(0);
  runtime.terminate();
  expect(runtime.instrumentation.shapeCacheBytes).toBe(0);
});

it("discards cancelled or edited batch results and lets unavailable providers fall back", async () => {
  const element = createTestStroke();
  const record: SceneElementRecord = {
    element,
    geometryVersion: 0,
    id: element.id,
    paintVersion: 0,
    band: "content",
    bounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
    rank: 0,
  };
  let finish!: (
    value: readonly { id: string; parts: readonly { d: string; paint: "fill" }[] }[],
  ) => void;
  let signal: AbortSignal | undefined;
  const store: SceneStorePort = {
    get: () => record,
    query: () => undefined,
    preparePressurePaths: (_, cancellation) => {
      signal = cancellation;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const preparation = new RemoteScenePaths(store);
  expect(preparation.read(record, () => [])).toBe("pending");
  preparation.cancel();
  expect(signal?.aborted).toBe(true);
  finish([{ id: record.id, parts: [{ d: "M0 0Z", paint: "fill" }] }]);
  await Promise.resolve();
  expect(preparation.memoryUsage()).toBe(0);
  expect(preparation.read(record, () => [])).toBe("pending");
  finish([{ id: record.id, parts: [{ d: "M0 0Z", paint: "fill" }] }]);
  await Promise.resolve();
  expect(preparation.read({ ...record, geometryVersion: 1 }, () => [])).toBeUndefined();
  preparation.cancel();
  expect(
    new RemoteScenePaths({ get: () => record, query: () => undefined }).read(record, () => []),
  ).toBeUndefined();
});
