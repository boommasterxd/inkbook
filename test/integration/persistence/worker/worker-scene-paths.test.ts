import { describe, expect, it } from "vitest";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { scenePathBytes } from "../../../../src/persistence/worker/runtime/scene-path-limits";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/document-runtime";
import {
  createWorkerBridgeClient,
  createWorkerBridgeHarness,
} from "../../../fixtures/persistence/worker-bridge";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";

const identity = {
  operationId: 2,
  purpose: "background" as const,
  sessionId: "session-a",
  workerEpoch: 1,
};

describe("worker canonical scene contour export reuse", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "reuses visible paths in export through bridge=%s, pressure=%s",
    async (bridge, pressureEnabled) => {
      const harness = createWorkerBridgeHarness();
      const port = bridge ? createWorkerBridgeClient(harness.clientEndpoint) : harness.runtime;
      const original = createTestStroke();
      const stroke = { ...original, style: { ...original.style, pressureEnabled } };
      const other = { ...stroke, id: "00000000-0000-4000-8000-000000000002" };
      await port.execute({
        baseModelRevision: null,
        identity,
        modelRevision: 0,
        snapshot: createWorkerSnapshot([stroke, other]),
        type: "model-sync-full",
      });
      expect(harness.runtime.instrumentation.shapeBuilds).toBe(0);
      const result = await port.execute({
        basisRevision: 0,
        identity,
        ids: [other.id],
        type: "prepare-scene-paths",
      });
      expect(result).toMatchObject({
        basisRevision: 0,
        type: "prepare-scene-paths-success",
        paths: [{ id: other.id, parts: buildElementPathParts(other) }],
      });
      expect(harness.runtime.instrumentation.shapeBuilds).toBe(1);
      await port.execute({
        basisRevision: 0,
        identity,
        ids: [other.id],
        type: "prepare-scene-paths",
      });
      expect(harness.runtime.instrumentation.shapeBuilds).toBe(1);
      const exported = await port.execute({
        baseModelRevision: 0,
        exportGeneration: 1,
        modelRevision: 0,
        sessionId: "session-a",
        workerEpoch: 1,
        type: "export-incremental",
      });
      expect(exported.type).toBe("export-success");
      expect(harness.runtime.instrumentation.shapeBuilds).toBe(2);
      port.terminate();
      harness.detach();
      expect(harness.runtime.instrumentation.shapeCacheBytes).toBe(0);
    },
  );
});

it.each([false, true])(
  "owns request IDs and identity before dispatch for streaming=%s",
  async (streamProgress) => {
    const harness = createWorkerBridgeHarness();
    const port = createWorkerBridgeClient(harness.clientEndpoint);
    const stroke = createTestStroke();
    try {
      await port.execute({
        baseModelRevision: null,
        identity,
        modelRevision: 0,
        snapshot: createWorkerSnapshot([stroke]),
        type: "model-sync-full",
      });
      const request = {
        type: "prepare-scene-paths" as const,
        basisRevision: 0,
        identity: { ...identity },
        ids: [stroke.id],
        visibleCount: 1,
        maxBytes: scenePathBytes(stroke.id, buildElementPathParts(stroke)),
        streamProgress,
      };
      const adopted: string[] = [];
      const pending = port.execute(request, {
        unlockBatch: () => undefined,
        scenePaths: (batch) => {
          adopted.push(...batch.paths.map(({ id }) => id));
        },
      });
      request.ids[0] = "unknown";
      request.identity.operationId++;
      request.basisRevision++;
      request.visibleCount = 0;
      request.maxBytes = 1;
      const result = await pending;
      expect(result).toMatchObject({
        type: "prepare-scene-paths-success",
        basisRevision: 0,
        identity,
      });
      expect(
        result.type === "prepare-scene-paths-success" && result.paths.map(({ id }) => id),
      ).toEqual(streamProgress ? [] : [stroke.id]);
      expect(adopted).toEqual(streamProgress ? [stroke.id] : []);
      expect(harness.runtime.instrumentation.shapeBuilds).toBe(1);
    } finally {
      port.terminate();
      harness.detach();
    }
  },
);

describe("worker canonical scene contour lifecycle", () => {
  it("rejects stale revisions and invalid batches before contour work, then respects model edits", async () => {
    const runtime = new DocumentWorkerRuntime(identity);
    const stroke = createTestStroke();
    await runtime.execute({
      baseModelRevision: null,
      identity,
      modelRevision: 0,
      snapshot: createWorkerSnapshot([stroke]),
      type: "model-sync-full",
    });
    for (const request of [
      { basisRevision: 1, ids: [stroke.id] },
      { basisRevision: 0, ids: [stroke.id, stroke.id] },
      { basisRevision: 0, ids: Array.from({ length: 257 }, (_, i) => String(i)) },
    ]) {
      expect(
        (await runtime.execute({ ...request, identity, type: "prepare-scene-paths" })).type,
      ).toBe("runtime-failure");
    }
    expect(runtime.instrumentation.shapeBuilds).toBe(0);
    const edited = { ...stroke, style: { ...stroke.style, width: 4 as const } };
    await runtime.execute({
      baseModelRevision: 0,
      identity,
      modelRevision: 1,
      changedElements: [edited],
      type: "model-sync-incremental",
    });
    expect(
      await runtime.execute({
        basisRevision: 1,
        identity,
        ids: [stroke.id, "missing"],
        type: "prepare-scene-paths",
      }),
    ).toMatchObject({ paths: [{ id: stroke.id, parts: buildElementPathParts(edited) }] });
    runtime.terminate();
  });

  it.each([false, true])(
    "cancels suspended geometry without a partial cache for pressure=%s",
    async (pressureEnabled) => {
      let block = false;
      let admitted!: () => void;
      const admission = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      const runtime = new DocumentWorkerRuntime(identity, {
        checkpoint: (signal) => {
          if (!block) return undefined;
          admitted();
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
          );
        },
        run: async (operation, signal) => operation(signal),
      });
      const original = createTestStroke();
      const stroke = { ...original, style: { ...original.style, pressureEnabled } };
      await runtime.execute({
        baseModelRevision: null,
        identity,
        modelRevision: 0,
        snapshot: createWorkerSnapshot([stroke]),
        type: "model-sync-full",
      });
      block = true;
      const pending = runtime.execute({
        basisRevision: 0,
        identity,
        ids: [stroke.id],
        type: "prepare-scene-paths",
      });
      await admission;
      runtime.cancelScenePreparation(identity);
      expect((await pending).type).toBe("runtime-failure");
      expect(runtime.instrumentation.shapeBuilds).toBe(0);
      expect(runtime.instrumentation.shapeCacheBytes).toBe(0);
      block = false;
      expect(
        (
          await runtime.execute({
            basisRevision: 0,
            identity,
            ids: [stroke.id],
            type: "prepare-scene-paths",
          })
        ).type,
      ).toBe("prepare-scene-paths-success");
      runtime.terminate();
    },
  );
});
