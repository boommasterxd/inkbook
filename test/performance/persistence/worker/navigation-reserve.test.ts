import { expect, it } from "vitest";
import {
  MAX_PREPARED_SCENE_PATH_BYTES,
  MAX_PREPARED_SCENE_PATH_IDS,
} from "../../../../src/domain/geometry/prepared-scene-paths";
import { scenePathBytes } from "../../../../src/persistence/worker/runtime/model/scene-path-limits";
import {
  createWorkerBridgeClient,
  createWorkerBridgeHarness,
} from "../../../fixtures/persistence/worker-bridge";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";
import {
  createSuspendedExportFixture,
  identity,
} from "../../../fixtures/persistence/navigation-export";

it.each([false, true])(
  "bounds navigation reserve geometry and reuses completed contours, bridge=%s",
  async (bridge) => {
    const harness = createWorkerBridgeHarness();
    const port = bridge ? createWorkerBridgeClient(harness.clientEndpoint) : harness.runtime;
    const snapshot = createNavigationSnapshot();
    const elements = snapshot.elements;
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
        snapshot,
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

it.each([
  { bridge: false, terminate: false },
  { bridge: true, terminate: false },
  { bridge: false, terminate: true },
  { bridge: true, terminate: true },
])("bounds suspended export work and contour ownership with %j", async ({ bridge, terminate }) => {
  const snapshot = createNavigationSnapshot();
  const fixture = createSuspendedExportFixture(bridge, snapshot);
  try {
    await fixture.synchronize();
    const exported = fixture.export().catch((error: unknown) => error);
    await fixture.parked;
    fixture.port.setNavigationActive?.(true);
    const request = {
      basisRevision: 0,
      identity: { ...identity, operationId: 10 },
      ids: snapshot.elements.slice(1, MAX_PREPARED_SCENE_PATH_IDS + 1).map(({ id }) => id),
      type: "prepare-scene-paths" as const,
    };
    const visible = fixture.port.execute(request);
    fixture.release();
    expect((await visible).type).toBe("prepare-scene-paths-success");
    const reserve = {
      ...request,
      identity: { ...identity, operationId: 11 },
      ids: snapshot.elements
        .slice(MAX_PREPARED_SCENE_PATH_IDS + 1, 2 * MAX_PREPARED_SCENE_PATH_IDS + 1)
        .map(({ id }) => id),
      speculative: true,
      navigationReserve: true,
    };
    expect((await fixture.port.execute(reserve)).type).toBe("prepare-scene-paths-success");
    expect((await fixture.port.execute(request)).type).toBe("prepare-scene-paths-success");
    const admittedShapes = 1 + 2 * MAX_PREPARED_SCENE_PATH_IDS;
    expect(fixture.runtime.instrumentation.shapeBuilds).toBe(admittedShapes);
    expect(fixture.runtime.instrumentation.shapeCacheElements).toBe(admittedShapes);
    expect(fixture.runtime.instrumentation.shapeCacheBytes).toBeLessThanOrEqual(
      3 * MAX_PREPARED_SCENE_PATH_BYTES,
    );
    expect(fixture.runtime.instrumentation.fragmentBuilds).toBe(1);
    expect(fixture.runtime.instrumentation.queuedJobs).toBe(1);
    expect(fixture.runtime.instrumentation.retainedJobs).toBe(1);
    if (terminate) {
      fixture.port.terminate();
      fixture.detach();
      expect(await exported).toBeInstanceOf(Error);
      expect(fixture.runtime.instrumentation.fragmentBuilds).toBe(1);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(0);
    } else {
      fixture.port.setNavigationActive?.(false);
      expect(await exported).toMatchObject({ type: "export-success" });
      expect(fixture.runtime.instrumentation.fragmentBuilds).toBe(snapshot.elements.length);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(snapshot.elements.length);
    }
    expect(fixture.runtime.instrumentation.queuedJobs).toBe(0);
    expect(fixture.runtime.instrumentation.retainedJobs).toBe(0);
  } finally {
    fixture.port.terminate();
    fixture.detach();
  }
  expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
  expect(fixture.runtime.instrumentation.cacheElements).toBe(0);
});

function createNavigationSnapshot() {
  const source = createTestStroke();
  return createWorkerSnapshot(
    Array.from({ length: 10_000 }, (_, index) => ({
      ...source,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    })),
  );
}
