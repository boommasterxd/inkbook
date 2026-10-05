import { expect, it, vi } from "vitest";
import { IncrementalDocumentSerializer } from "../../../../src/persistence/serialization/incremental-document-serializer";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/document-runtime";
import { attachDocumentWorkerHost } from "../../../../src/persistence/worker/runtime/worker-host";
import {
  MAX_SCENE_PATH_BYTES,
  scenePathBytes,
} from "../../../../src/persistence/worker/runtime/scene-path-limits";
import type { DocumentRuntimeObserver } from "../../../../src/persistence/worker/runtime/types";
import {
  createWorkerBridgeClient,
  createWorkerBridgeEndpoints,
} from "../../../fixtures/persistence/worker-bridge";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";

const identity = {
  sessionId: "session-a",
  workerEpoch: 1,
  operationId: 2,
  purpose: "background" as const,
};

it.each([false, true])(
  "offers the exact visible prefix before any overscan geometry without a CPU yield, bridge=%s",
  async (bridge) => {
    const fixture = await capacityFixture(bridge, false);
    const batches: string[][] = [];
    let firstPathBytes = 0;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the actual serializer through call.
    const original = IncrementalDocumentSerializer.prototype.prepareScenePath;
    const prepare = vi
      .spyOn(IncrementalDocumentSerializer.prototype, "prepareScenePath")
      .mockImplementation(function (this: IncrementalDocumentSerializer, id, context) {
        if (id === fixture.ids[3]) {
          expect(fixture.runtime.instrumentation.shapeBuilds).toBe(3);
          expect(fixture.sentIds(batches)).toEqual(fixture.ids.slice(0, 3));
        }
        return original.call(this, id, context);
      });
    try {
      expect(
        await fixture.prepare((batch) => {
          batches.push(batch.paths.map(({ id }) => id));
          firstPathBytes ||= scenePathBytes(batch.paths[0]!.id, batch.paths[0]!.parts);
        }),
      ).toMatchObject({ type: "prepare-scene-paths-success", paths: [] });
      expect(batches).toEqual([fixture.ids.slice(0, 3), fixture.ids.slice(3)]);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(256);
      expect(fixture.handoffs()).toBe(0);
      prepare.mockRestore();
      const boundedIds: string[] = [];
      expect(
        await fixture.prepare((batch) => {
          boundedIds.push(...batch.paths.map(({ id }) => id));
          expect(
            batch.paths.reduce((bytes, path) => bytes + scenePathBytes(path.id, path.parts), 0),
          ).toBeLessThanOrEqual(firstPathBytes);
        }, firstPathBytes),
      ).toMatchObject({ paths: [] });
      expect(boundedIds).toEqual([fixture.ids[0]]);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(256);
    } finally {
      prepare.mockRestore();
      fixture.close();
    }
    expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
  },
);

it.each([
  [false, "complete"],
  [true, "complete"],
  [false, "cancel"],
  [true, "cancel"],
  [false, "retarget"],
  [true, "retarget"],
] as const)(
  "keeps pending visible contours separate from capacity-sized overscan with one ACK, bridge=%s, terminal=%s",
  async (bridge, terminal) => {
    const fixture = await capacityFixture(bridge, true);
    const acknowledgement = deferred();
    const first = deferred();
    const geometry = deferred();
    const batches: string[][] = [];
    let bytes = 0;
    let adoptionSignal: AbortSignal | undefined;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the actual serializer through call.
    const original = IncrementalDocumentSerializer.prototype.prepareScenePath;
    const prepare = vi
      .spyOn(IncrementalDocumentSerializer.prototype, "prepareScenePath")
      .mockImplementation(async function (this: IncrementalDocumentSerializer, id, context) {
        const parts = await original.call(this, id, context);
        if (id === fixture.ids[255]) geometry.resolve();
        return parts;
      });
    try {
      const pending = fixture
        .prepare((batch, signal) => {
          adoptionSignal = signal;
          batches.push(batch.paths.map(({ id }) => id));
          bytes += batch.paths.reduce(
            (total, path) => total + scenePathBytes(path.id, path.parts),
            0,
          );
          first.resolve();
          return acknowledgement.promise;
        })
        .catch(() => undefined);
      await first.promise;
      fixture.resume();
      await geometry.promise;
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(256);
      expect(batches).toEqual([[fixture.ids[0]]]);
      expect(fixture.sentIds(batches)).toEqual([fixture.ids[0]]);
      if (terminal === "cancel") fixture.port.cancelScenePreparation?.(identity);
      if (terminal === "retarget")
        fixture.port.retargetScenePreparation?.(identity, [
          fixture.ids[0]!,
          fixture.ids[1]!,
          fixture.ids[255]!,
        ]);
      if (terminal !== "cancel") acknowledgement.resolve();
      const result = await pending;
      if (terminal === "cancel") {
        expect(result?.type).not.toBe("prepare-scene-paths-success");
        expect(adoptionSignal?.aborted).toBe(true);
        expect(batches).toHaveLength(1);
      } else {
        expect(result).toMatchObject({ type: "prepare-scene-paths-success", paths: [] });
        expect(batches).toEqual(
          terminal === "retarget"
            ? [[fixture.ids[0]], [fixture.ids[1]], [fixture.ids[255]]]
            : [[fixture.ids[0]], fixture.ids.slice(1, 3), fixture.ids.slice(3)],
        );
      }
      expect(bytes).toBeLessThanOrEqual(MAX_SCENE_PATH_BYTES);
      expect(fixture.sentIds(batches).length).toBeLessThanOrEqual(256);
    } finally {
      acknowledgement.resolve();
      prepare.mockRestore();
      fixture.close();
    }
    expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
  },
);

it.each([false, true])(
  "admits an ACK-driven visible flush while overscan geometry is suspended, bridge=%s",
  async (bridge) => {
    const fixture = await capacityFixture(bridge, true);
    const acknowledgement = deferred();
    const first = deferred();
    const second = deferred();
    const overscan = deferred();
    const resumeGeometry = deferred();
    const batches: string[][] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the actual serializer through call.
    const original = IncrementalDocumentSerializer.prototype.prepareScenePath;
    const prepare = vi
      .spyOn(IncrementalDocumentSerializer.prototype, "prepareScenePath")
      .mockImplementation(async function (this: IncrementalDocumentSerializer, id, context) {
        if (id === fixture.ids[3]) {
          overscan.resolve();
          await resumeGeometry.promise;
        }
        return original.call(this, id, context);
      });
    try {
      const pending = fixture.prepare((batch) => {
        batches.push(batch.paths.map(({ id }) => id));
        if (batches.length === 1) {
          first.resolve();
          return acknowledgement.promise;
        }
        second.resolve();
        return undefined;
      });
      await first.promise;
      fixture.resume();
      await overscan.promise;
      fixture.holdAdmissions();
      acknowledgement.resolve();
      await fixture.admissionRequested;
      expect(batches).toEqual([[fixture.ids[0]]]);
      fixture.releaseAdmissions();
      await second.promise;
      expect(batches).toEqual([[fixture.ids[0]], fixture.ids.slice(1, 3)]);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(3);
      resumeGeometry.resolve();
      expect(await pending).toMatchObject({ type: "prepare-scene-paths-success", paths: [] });
      expect(batches.flat()).toEqual(fixture.ids);
    } finally {
      acknowledgement.resolve();
      resumeGeometry.resolve();
      fixture.releaseAdmissions();
      prepare.mockRestore();
      fixture.close();
    }
    expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
  },
);

async function capacityFixture(bridge: boolean, initiallyBlocked: boolean) {
  let blocked = initiallyBlocked;
  let admissionsHeld = false;
  let handoffs = 0;
  const handoff = deferred();
  const admission = deferred();
  const admissionRequested = deferred();
  const runtime = new DocumentWorkerRuntime(identity, {
    checkpoint: () => {
      if (admissionsHeld) {
        admissionRequested.resolve();
        return admission.promise;
      }
      if (!blocked || runtime.instrumentation.shapeBuilds !== 1) return undefined;
      handoffs++;
      return handoff.promise;
    },
    run: async (operation, signal) => operation(signal),
  });
  const endpoints = createWorkerBridgeEndpoints();
  const detach = attachDocumentWorkerHost(endpoints.hostEndpoint, runtime);
  const port = bridge ? createWorkerBridgeClient(endpoints.clientEndpoint) : runtime;
  const elements = Array.from({ length: 256 }, (_, index) => ({
    ...createTestStroke(),
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  }));
  await port.execute({
    baseModelRevision: null,
    identity,
    modelRevision: 0,
    snapshot: createWorkerSnapshot(elements),
    type: "model-sync-full",
  });
  const ids = elements.map(({ id }) => id);
  return {
    ids,
    port,
    runtime,
    admissionRequested: admissionRequested.promise,
    holdAdmissions: () => {
      admissionsHeld = true;
    },
    releaseAdmissions: () => {
      admissionsHeld = false;
      admission.resolve();
    },
    handoffs: () => handoffs,
    prepare: (scenePaths: NonNullable<DocumentRuntimeObserver["scenePaths"]>, maxBytes?: number) =>
      port.execute(
        {
          basisRevision: 0,
          identity,
          ids,
          visibleCount: 3,
          ...(maxBytes === undefined ? {} : { maxBytes }),
          streamProgress: true,
          type: "prepare-scene-paths",
        },
        { unlockBatch: () => undefined, scenePaths },
      ),
    sentIds: (batches: string[][]): string[] =>
      bridge
        ? endpoints.hostEndpoint.sentMessages.flatMap((message) => {
            const batch = message as { type: string; batch?: { paths: readonly { id: string }[] } };
            return batch.type === "inkbook-worker-scene-paths"
              ? batch.batch!.paths.map(({ id }) => id)
              : [];
          })
        : batches.flat(),
    resume: () => {
      blocked = false;
      handoff.resolve();
    },
    close: () => {
      port.terminate();
      detach();
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}
