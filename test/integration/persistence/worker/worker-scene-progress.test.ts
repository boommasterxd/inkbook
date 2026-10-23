import { expect, it, vi } from "vitest";
import { IncrementalDocumentSerializer } from "../../../../src/persistence/serialization/output/incremental-document-serializer";
import {
  MAX_SCENE_PATH_BYTES,
  scenePathBytes,
} from "../../../../src/persistence/worker/runtime/model/scene-path-limits";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/document-runtime";
import { WorkerDocumentRuntimePort } from "../../../../src/persistence/worker/runtime/bridge/worker-bridge";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import {
  createWorkerBridgeClient,
  createWorkerBridgeEndpoints,
  createWorkerBridgeHarness,
} from "../../../fixtures/persistence/worker-bridge";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";

import {
  createScenePathProgressFixture as streamingFixture,
  scenePathProgressIdentity as identity,
  scenePathDeferred as deferred,
  scenePathProgressCases,
} from "../../../fixtures/persistence/scene-path-progress";

it.each([false, true])(
  "publishes complete paths at a shared handoff and prunes obsolete work, bridge=%s",
  async (bridge) => {
    const fixture = await streamingFixture(bridge);
    const progress: string[][] = [];
    const ready = deferred();
    let settled = false;
    const pending = fixture
      .prepare((batch) => {
        progress.push(batch.paths.map(({ id }) => id));
        ready.resolve();
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await ready.promise;
    expect(progress).toEqual([[fixture.ids[0]]]);
    expect(settled).toBe(false);
    expect(fixture.runtime.instrumentation.shapeBuilds).toBe(1);
    fixture.port.retargetScenePreparation?.({ ...identity, operationId: 999 }, []);
    fixture.port.retargetScenePreparation?.(identity, [fixture.ids[0]!, fixture.lastId]);
    fixture.resume();
    const result = await pending;
    expect(result).toMatchObject({
      type: "prepare-scene-paths-success",
      paths: [],
    });
    expect(progress).toEqual([[fixture.ids[0]], [fixture.lastId]]);
    expect(fixture.runtime.instrumentation.shapeBuilds).toBe(2);
    fixture.close();
    expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
  },
);

it.each(scenePathProgressCases("complete", "cancel", "error"))(
  "continues centrally admitted geometry with one blocked ACK, bridge=%s, terminal=%s",
  async (bridge, terminal) => {
    const fixture = await streamingFixture(bridge);
    const ready = deferred();
    const adoption = deferred();
    const geometry = observePreparedGeometry(fixture.lastId);
    const ids: string[] = [];
    let bytes = 0;
    let calls = 0;
    let settled = false;
    const pending = fixture.prepare((batch) => {
      calls++;
      ids.push(...batch.paths.map(({ id }) => id));
      bytes += batch.paths.reduce((total, path) => total + scenePathBytes(path.id, path.parts), 0);
      ready.resolve();
      return adoption.promise;
    });
    // Bridge cancellation rejects its pending request; fallback returns a typed failure.
    const completion = pending
      .catch(() => undefined)
      .then((result) => {
        settled = true;
        return result;
      });
    await ready.promise;
    expect(fixture.runtime.instrumentation.shapeBuilds).toBe(1);
    fixture.resume();
    await geometry.promise;
    expect(calls).toBe(1);
    if (bridge) expect(fixture.progressMessages()).toBe(1);
    expect(settled).toBe(false);
    expect(fixture.runtime.instrumentation.shapeBuilds).toBe(256);
    if (terminal === "cancel") fixture.port.cancelScenePreparation?.(identity);
    else if (terminal === "error") adoption.reject(new Error("rejected ACK"));
    else adoption.resolve();
    const result = await completion;
    if (terminal === "complete") {
      expect(result).toMatchObject({ type: "prepare-scene-paths-success", paths: [] });
      expect(calls).toBe(2);
      if (bridge) expect(fixture.progressMessages()).toBe(2);
      expect(ids).toEqual(fixture.ids);
    } else expect(result?.type).not.toBe("prepare-scene-paths-success");
    expect(bytes).toBeLessThanOrEqual(MAX_SCENE_PATH_BYTES);
    adoption.resolve();
    geometry.restore();
    fixture.close();
    expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
  },
);

it.each([false, true])(
  "fails at the next central continuation after a rejected ACK, bridge=%s",
  async (bridge) => {
    const fixture = await streamingFixture(bridge);
    const ready = deferred();
    const acknowledgement = deferred();
    const pending = fixture
      .prepare(() => {
        ready.resolve();
        return acknowledgement.promise;
      })
      .catch(() => undefined);
    await ready.promise;
    acknowledgement.reject(new Error("rejected ACK"));
    if (bridge) await fixture.rejectedAcknowledgement;
    fixture.resume();
    expect((await pending)?.type).not.toBe("prepare-scene-paths-success");
    expect(fixture.runtime.instrumentation.shapeBuilds).toBe(1);
    fixture.close();
    expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
  },
);

it.each([false, true])(
  "releases a reserve ACK for visible demand and reuses its completed contour, bridge=%s",
  async (bridge) => {
    const fixture = await streamingFixture(bridge, { navigationReserve: true });
    const ready = deferred();
    const adoption = deferred();
    let signal!: AbortSignal;
    const pending = fixture
      .prepare((_, adoptionSignal) => {
        signal = adoptionSignal;
        ready.resolve();
        return adoption.promise;
      })
      .catch(() => undefined);
    try {
      await ready.promise;
      fixture.port.setNavigationActive?.(true);
      expect(signal.aborted).toBe(false);
      expect(fixture.progressMessages()).toBe(bridge ? 1 : 0);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(1);
      const visible = fixture.port.execute({
        basisRevision: 0,
        identity: { ...identity, operationId: 3 },
        ids: [fixture.ids[0]!],
        type: "prepare-scene-paths",
      });
      expect((await pending)?.type).not.toBe("prepare-scene-paths-success");
      fixture.resume();
      expect((await visible).type).toBe("prepare-scene-paths-success");
      expect(signal.aborted).toBe(true);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(1);
      expect(fixture.runtime.instrumentation.shapeCacheElements).toBe(1);
      expect(fixture.runtime.instrumentation.fragmentBuilds).toBe(0);
    } finally {
      adoption.resolve();
      fixture.close();
    }
    expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
  },
);

it.each([false, true])(
  "releases a blocked progress ACK after geometry failure, bridge=%s",
  async (bridge) => {
    const fixture = await streamingFixture(bridge);
    const geometry = observePreparedGeometry(fixture.lastId, true);
    const ready = deferred();
    const acknowledgement = deferred();
    let adoptionSignal!: AbortSignal;
    const pending = fixture
      .prepare((_, signal) => {
        adoptionSignal = signal;
        ready.resolve();
        return acknowledgement.promise;
      })
      .catch(() => undefined);
    await ready.promise;
    fixture.resume();
    await geometry.promise;
    expect((await pending)?.type).not.toBe("prepare-scene-paths-success");
    expect(adoptionSignal.aborted).toBe(true);
    acknowledgement.resolve();
    geometry.restore();
    fixture.close();
    expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
  },
);

it("admits progress only after live input and the injected shared frame scheduler release it", async () => {
  const endpoints = createWorkerBridgeEndpoints();
  const frame = deferred();
  const scheduled = deferred();
  const adopted = deferred();
  let expired = false;
  let calls = 0;
  const port = new WorkerDocumentRuntimePort(() => endpoints.clientEndpoint, {
    frameIntervalMilliseconds: () => 1000 / 120,
    workScheduler: new TestWorkScheduler({
      shouldYield: () => expired,
      nextFrame: () => {
        scheduled.resolve();
        return frame.promise;
      },
    }),
  });
  const pending = port.execute(
    {
      basisRevision: 0,
      identity,
      ids: ["first"],
      streamProgress: true,
      type: "prepare-scene-paths",
    },
    {
      unlockBatch: () => undefined,
      scenePaths: () => {
        calls++;
        adopted.resolve();
      },
    },
  );
  const completion = pending.catch(() => undefined);
  port.setLiveInputActive(true);
  expired = true;
  const batch = {
    basisRevision: 0,
    identity,
    paths: [{ id: "first", parts: [{ d: "M0 0Z", paint: "fill" }] }],
    type: "prepare-scene-paths-success",
  };
  endpoints.hostEndpoint.postMessage({
    batch,
    batchIndex: 0,
    requestId: 1,
    type: "inkbook-worker-scene-paths",
  });
  expect(calls).toBe(0);
  port.setLiveInputActive(false);
  await scheduled.promise;
  expect(calls).toBe(0);
  expired = false;
  frame.resolve();
  await adopted.promise;
  expect(calls).toBe(1);
  port.cancelScenePreparation(identity);
  await completion;
  port.terminate();
});

it.each([false, true])(
  "requires a streaming observer and keeps legacy complete results, bridge=%s",
  async (bridge) => {
    const harness = createWorkerBridgeHarness();
    const port = bridge ? createWorkerBridgeClient(harness.clientEndpoint) : harness.runtime;
    const invalid = await port
      .execute({
        basisRevision: 0,
        identity,
        ids: [],
        streamProgress: true,
        type: "prepare-scene-paths",
      })
      .catch(() => undefined);
    expect(invalid?.type).not.toBe("prepare-scene-paths-success");
    const element = createTestStroke();
    await port.execute({
      baseModelRevision: null,
      identity,
      modelRevision: 0,
      snapshot: createWorkerSnapshot([element]),
      type: "model-sync-full",
    });
    let progress = 0;
    const result = await port.execute(
      {
        basisRevision: 0,
        identity,
        ids: [element.id],
        streamProgress: false,
        type: "prepare-scene-paths",
      },
      {
        unlockBatch: () => undefined,
        scenePaths: () => {
          progress++;
        },
      },
    );
    expect(result).toMatchObject({ paths: [{ id: element.id }] });
    expect(progress).toBe(0);
    port.terminate();
    harness.detach();
  },
);

it("rejects malformed fallback IDs before queue admission and permits valid follow-up work", async () => {
  const runtime = new DocumentWorkerRuntime(identity);
  for (const ids of [undefined, null, {}]) {
    const failure = await runtime.execute({
      basisRevision: 0,
      identity,
      ids: ids as readonly string[],
      type: "prepare-scene-paths",
    });
    expect(failure.type).toBe("runtime-failure");
  }
  expect(
    await runtime.execute({
      basisRevision: 0,
      identity,
      ids: [],
      streamProgress: "invalid" as unknown as boolean,
      type: "prepare-scene-paths",
    }),
  ).toMatchObject({ type: "runtime-failure" });
  const stroke = createTestStroke();
  expect(
    await runtime.execute({
      baseModelRevision: null,
      identity,
      modelRevision: 0,
      snapshot: createWorkerSnapshot([stroke]),
      type: "model-sync-full",
    }),
  ).toMatchObject({ type: "model-sync-success" });
  expect(
    await runtime.execute({
      basisRevision: 0,
      identity,
      ids: [stroke.id],
      type: "prepare-scene-paths",
    }),
  ).toMatchObject({
    type: "prepare-scene-paths-success",
    paths: [{ id: stroke.id }],
  });
  expect(runtime.instrumentation.shapeBuilds).toBe(1);
  expect(
    await runtime.execute({
      baseModelRevision: 0,
      exportGeneration: 1,
      modelRevision: 0,
      sessionId: identity.sessionId,
      workerEpoch: identity.workerEpoch,
      type: "export-incremental",
    }),
  ).toMatchObject({ type: "export-success" });
  runtime.terminate();
});

function observePreparedGeometry(id: string, failAfter = false) {
  const geometry = deferred();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked through call with the actual serializer instance.
  const original = IncrementalDocumentSerializer.prototype.prepareScenePath;
  const spy = vi
    .spyOn(IncrementalDocumentSerializer.prototype, "prepareScenePath")
    .mockImplementation(async function (this: IncrementalDocumentSerializer, candidate, context) {
      const parts = await original.call(this, candidate, context);
      if (candidate === id) {
        geometry.resolve();
        if (failAfter) throw new Error("geometry failed");
      }
      return parts;
    });
  return { promise: geometry.promise, restore: () => spy.mockRestore() };
}
