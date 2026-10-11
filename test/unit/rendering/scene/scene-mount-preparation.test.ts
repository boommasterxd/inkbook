import { afterEach, expect, it, vi } from "vitest";
import { SceneMountPreparation } from "../../../../src/rendering/scene/scene-mount-preparation";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import { MountSlice } from "../../../../src/rendering/scene/mount-slice";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { createSceneRecord } from "../../../fixtures/rendering/scene";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { asDocument, FakeDocument } from "./fakes";

afterEach(() => vi.restoreAllMocks());

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
    const preparation = new SceneMountPreparation({
      ownerDocument: asDocument(new FakeDocument()),
      instrumentation: createInstrumentation(),
      pathCache: cache,
      store: {
        get: () => record,
        query: vi.fn(),
        prepareScenePaths: prepare,
        pressureGeometry: () => pressure,
      },
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
