import { afterEach, expect, it, vi } from "vitest";
import { SceneMountPreparation } from "../../../../../src/rendering/scene/reconciliation/scene-mount-preparation";
import { ScenePathCache } from "../../../../../src/rendering/scene/content/path-cache";
import { MountSlice } from "../../../../../src/rendering/scene/reconciliation/mount-slice";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import type { SceneStorePort } from "../../../../../src/rendering/scene/types";
import { createSceneRecord } from "../../../../fixtures/rendering/scene";
import { createTestStroke } from "../../../../fixtures/persistence/worker-snapshot";
import { asDocument, FakeDocument } from "../fakes";

afterEach(() => vi.restoreAllMocks());

function mountPreparation(pathCache: ScenePathCache, store: SceneStorePort) {
  return new SceneMountPreparation({
    ownerDocument: asDocument(new FakeDocument()),
    instrumentation: createInstrumentation(),
    pathCache,
    store,
  });
}

it("keeps a newer worker reservation when an older canonical target finishes", async () => {
  const stroke = createTestStroke();
  Object.freeze(stroke.points);
  const record = { ...createSceneRecord(stroke), geometryVersion: 2 };
  const parts = [{ d: "M0 0Z", paint: "fill" as const }];
  const cache = new ScenePathCache();
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let requestSignal: AbortSignal | undefined;
  const prepare = vi.fn(async (_ids: readonly string[], signal: AbortSignal) => {
    requestSignal = signal;
    await gate;
    return [{ id: record.id, parts }];
  });
  const preparation = mountPreparation(cache, {
    get: () => record,
    query: vi.fn(),
    prepareScenePaths: prepare,
  });
  const slice = new MountSlice(Infinity, () => 0);
  expect(preparation.stage(record, slice, undefined)).toBeUndefined();
  preparation.finish(record.id, 1);
  expect(requestSignal?.aborted).toBe(false);
  complete();
  await gate;
  await Promise.resolve();
  expect(preparation.stage(record, slice, undefined)?.pathParts).toBe(parts);
  expect(prepare).toHaveBeenCalledOnce();
  preparation.cancel();
  cache.release();
  expect(preparation.memoryUsage()).toBe(0);
});

it.each([true, false])(
  "adopts a remote contour once before mount with retention %s",
  async (retention) => {
    const stroke = createTestStroke();
    Object.freeze(stroke.points);
    const record = createSceneRecord(stroke);
    const parts = [{ d: "M0 0Z", paint: "fill" as const }];
    const cache = new ScenePathCache();
    cache.setRetentionEnabled(retention);
    const complete = vi.spyOn(cache, "completePreparation");
    const pressure = { readWindow: vi.fn(), publishWindow: vi.fn(), publishPath: vi.fn() };
    const prepare = vi.fn(async () => [{ id: record.id, parts }]);
    const preparation = mountPreparation(cache, {
      get: () => record,
      query: vi.fn(),
      prepareScenePaths: prepare,
      pressureGeometry: () => pressure,
    });
    const slice = new MountSlice(Infinity, () => 0);
    expect(preparation.stage(record, slice, undefined)).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(preparation.stage(record, slice, undefined)?.pathParts).toBe(parts);
    expect(prepare).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledExactlyOnceWith(record.element, parts, record.geometryVersion);
    expect(pressure.publishPath).toHaveBeenCalledExactlyOnceWith(parts);
    preparation.cancel();
    cache.release();
    expect(preparation.memoryUsage()).toBe(0);
    expect(cache.cacheMemoryUsage()).toBe(0);
  },
);
