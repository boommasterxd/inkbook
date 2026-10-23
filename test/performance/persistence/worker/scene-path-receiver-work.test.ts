import { expect, it, vi } from "vitest";
import { ScenePathReceiver } from "../../../../src/persistence/worker/runtime/bridge/scene-path-receiver";
import { ScenePathValidationContext } from "../../../../src/persistence/worker/runtime/model/scene-path-limits";
import type { BridgeScenePaths } from "../../../../src/persistence/worker/runtime/bridge/bridge-messages";
import type { PreparedScenePathsRuntimeSuccess } from "../../../../src/persistence/worker/runtime/types";

it.each([false, true])(
  "validates capacity-sized progress with one ID lookup and contour read per path, singleton=%s",
  async (singleton) => {
    const fixture = capacityStream();
    const receiver = new ScenePathReceiver(fixture.request);
    expect(fixture.idReads()).toBe(256);
    const lookup = vi.spyOn(ScenePathValidationContext.prototype, "position");
    const signal = new AbortController().signal;
    let adopted = 0;
    const observer = {
      unlockBatch: () => undefined,
      scenePaths: (batch: PreparedScenePathsRuntimeSuccess) => {
        adopted += batch.paths.length;
      },
    };
    const chunks = singleton
      ? fixture.paths.map((path) => [path])
      : [fixture.paths.slice(0, 1), fixture.paths.slice(1)];
    try {
      for (const [batchIndex, paths] of chunks.entries()) {
        await receiver.adopt(
          fixture.message(paths, batchIndex),
          fixture.request,
          observer,
          signal,
          () => undefined,
        );
      }
      await receiver.validateResult(fixture.request, fixture.message([], chunks.length).batch, {
        checkpoint: () => undefined,
        signal,
      });
      expect(adopted).toBe(256);
      expect(lookup).toHaveBeenCalledTimes(256);
      expect(fixture.idReads()).toBe(256);
      expect(fixture.contourReads()).toBe(256);
      expect(receiver.waiting).toBe(false);
    } finally {
      lookup.mockRestore();
    }
  },
);

it("cancels at the shared response checkpoint before adopting or inspecting the remaining capacity", async () => {
  const fixture = capacityStream();
  const receiver = new ScenePathReceiver(fixture.request);
  const lookup = vi.spyOn(ScenePathValidationContext.prototype, "position");
  const controller = new AbortController();
  const scenePaths = vi.fn();
  let checkpoints = 0;
  try {
    await expect(
      receiver.adopt(
        fixture.message(fixture.paths, 0),
        fixture.request,
        { unlockBatch: () => undefined, scenePaths },
        controller.signal,
        () => {
          if (++checkpoints === 2) controller.abort(new Error("cancelled response"));
          return Promise.resolve();
        },
      ),
    ).rejects.toThrow("cancelled response");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fixture.idReads()).toBe(256);
    expect(fixture.contourReads()).toBe(1);
    expect(scenePaths).not.toHaveBeenCalled();
    expect(receiver.waiting).toBe(false);
  } finally {
    lookup.mockRestore();
  }
});

function capacityStream() {
  let idReads = 0;
  let contourReads = 0;
  const keys = Array.from({ length: 256 }, (_, index) => `stroke-${index}`);
  const ids = new Proxy(keys, {
    get: (target, property, receiver) => {
      if (typeof property === "string" && /^\d+$/u.test(property)) idReads++;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const identity = {
    sessionId: "session-a",
    workerEpoch: 1,
    operationId: 1,
    purpose: "background" as const,
  };
  const request = {
    type: "prepare-scene-paths" as const,
    identity,
    ids,
    basisRevision: 0,
    streamProgress: true,
  };
  const paths = keys.map((id) => ({
    id,
    parts: [
      {
        get d() {
          contourReads++;
          return "M0 0L10 10Z";
        },
        paint: "fill" as const,
      },
    ],
  }));
  const message = (batch: typeof paths, batchIndex: number): BridgeScenePaths => ({
    type: "inkbook-worker-scene-paths",
    requestId: 1,
    batchIndex,
    batch: { type: "prepare-scene-paths-success", identity, basisRevision: 0, paths: batch },
  });
  return { request, paths, message, idReads: () => idReads, contourReads: () => contourReads };
}
