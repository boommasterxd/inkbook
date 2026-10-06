import { expect, it } from "vitest";
import {
  MAX_PREPARED_SCENE_PATH_BYTES,
  MAX_PREPARED_SCENE_PATH_IDS,
} from "../../../src/domain/geometry/prepared-scene-paths";
import { scenePathBytes } from "../../../src/persistence/worker/runtime/scene-path-limits";
import {
  createWorkerBridgeClient,
  createWorkerBridgeHarness,
} from "../../fixtures/persistence/worker-bridge";
import { createTestStroke, createWorkerSnapshot } from "../../fixtures/persistence/worker-snapshot";

it.each([false, true])(
  "bounds navigation reserve geometry and reuses completed contours, bridge=%s",
  async (bridge) => {
    const harness = createWorkerBridgeHarness();
    const port = bridge ? createWorkerBridgeClient(harness.clientEndpoint) : harness.runtime;
    const source = createTestStroke();
    const elements = Array.from({ length: 10_000 }, (_, index) => ({
      ...source,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    const identity = {
      operationId: 1,
      purpose: "background" as const,
      sessionId: "session-a",
      workerEpoch: 1,
    };
    const ids = elements.slice(0, MAX_PREPARED_SCENE_PATH_IDS).map(({ id }) => id);
    const request = {
      basisRevision: 0,
      identity,
      ids,
      maxBytes: MAX_PREPARED_SCENE_PATH_BYTES,
      navigationReserve: true,
      speculative: true,
      streamProgress: true,
      type: "prepare-scene-paths" as const,
    };
    let publishedBytes = 0;
    let publishedContours = 0;
    const observer = {
      unlockBatch: () => undefined,
      scenePaths: (batch: {
        paths: readonly { id: string; parts: Parameters<typeof scenePathBytes>[1] }[];
      }) => {
        publishedContours += batch.paths.length;
        publishedBytes += batch.paths.reduce(
          (bytes, { id, parts }) => bytes + scenePathBytes(id, parts),
          0,
        );
      },
    };
    try {
      await port.execute({
        baseModelRevision: null,
        identity,
        modelRevision: 0,
        snapshot: createWorkerSnapshot(elements),
        type: "model-sync-full",
      });
      port.setNavigationActive?.(true);
      expect((await port.execute(request, observer)).type).toBe("prepare-scene-paths-success");
      expect(publishedContours).toBe(MAX_PREPARED_SCENE_PATH_IDS);
      expect(publishedBytes).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_BYTES);
      expect(harness.runtime.instrumentation.shapeBuilds).toBe(MAX_PREPARED_SCENE_PATH_IDS);
      expect(harness.runtime.instrumentation.fragmentBuilds).toBe(0);
      expect(harness.runtime.instrumentation.shapeCacheElements).toBe(MAX_PREPARED_SCENE_PATH_IDS);
      expect(harness.runtime.instrumentation.shapeCacheBytes).toBeLessThanOrEqual(
        MAX_PREPARED_SCENE_PATH_BYTES,
      );
      expect(
        (await port.execute({ ...request, identity: { ...identity, operationId: 2 } }, observer))
          .type,
      ).toBe("prepare-scene-paths-success");
      expect(harness.runtime.instrumentation.shapeBuilds).toBe(MAX_PREPARED_SCENE_PATH_IDS);
      const oversized = port.execute(
        { ...request, ids: elements.slice(0, 257).map(({ id }) => id) },
        observer,
      );
      if (bridge) await expect(oversized).rejects.toThrow("protocol limit");
      else expect((await oversized).type).toBe("runtime-failure");
      expect(harness.runtime.instrumentation.shapeBuilds).toBe(MAX_PREPARED_SCENE_PATH_IDS);
    } finally {
      port.terminate();
      harness.detach();
    }
    expect(harness.runtime.instrumentation.shapeCacheBytes).toBe(0);
    expect(harness.runtime.instrumentation.cacheElements).toBe(0);
  },
);
