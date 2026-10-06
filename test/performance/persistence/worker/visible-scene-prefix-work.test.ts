import { expect, it, vi } from "vitest";
import { IncrementalDocumentSerializer } from "../../../../src/persistence/serialization/incremental-document-serializer";
import { DocumentModelRuntime } from "../../../../src/persistence/worker/runtime/document-model";
import type { DocumentRuntimeRequest } from "../../../../src/persistence/worker/runtime/types";
import {
  MAX_SCENE_PATH_BYTES,
  scenePathBytes,
} from "../../../../src/persistence/worker/runtime/scene-path-limits";
import {
  createScenePathProgressFixture,
  scenePathProgressIdentity as identity,
  scenePathDeferred as deferred,
  scenePathProgressCases,
} from "../../../fixtures/persistence/scene-path-progress";

it.each(
  scenePathProgressCases(
    "clipboard-decode",
    "clipboard-plan-paste",
    "preflight",
    "read-back",
    "export-full",
    "model-sync-full",
    "model-sync-incremental",
  ),
)(
  "defers document contour work behind an admitted %s request, operation=%s",
  async (bridge, operation) => {
    const fixture = await createScenePathProgressFixture(bridge, {
      speculative: true,
      initiallyBlocked: false,
    });
    const started = deferred();
    const released = deferred();
    const run = vi.spyOn(fixture.scheduler, "run");
    let admissions = 0;
    run.mockImplementation(
      async <T>(
        execute: (signal: AbortSignal) => T | Promise<T>,
        signal: AbortSignal,
      ): Promise<T> => {
        if (++admissions === 1) {
          started.resolve();
          await released.promise;
        }
        return execute(signal);
      },
    );
    const clipboardIdentity = { ...identity, operationId: 3, purpose: "clipboard" as const };
    let request: DocumentRuntimeRequest;
    if (operation === "export-full")
      request = {
        ...identity,
        baseModelRevision: null,
        exportGeneration: 1,
        modelRevision: 0,
        snapshot: fixture.snapshot,
        type: operation,
      };
    else if (operation === "model-sync-full")
      request = {
        baseModelRevision: null,
        identity: clipboardIdentity,
        modelRevision: 0,
        snapshot: fixture.snapshot,
        type: operation,
      };
    else if (operation === "model-sync-incremental")
      request = {
        baseModelRevision: 0,
        identity: clipboardIdentity,
        modelRevision: 0,
        type: operation,
      };
    else if (operation === "preflight" || operation === "read-back")
      request = {
        identity: { ...clipboardIdentity, purpose: operation },
        input: "<svg>",
        type: "verify-output",
      };
    else
      request = {
        basisRevision: 0,
        candidates: {},
        identity: clipboardIdentity,
        type: operation,
        ...(operation === "clipboard-plan-paste"
          ? {
              commandTimestamp: 0,
              invocation: { kind: "toolbar" as const, visibleCanvasCenter: { x: 0, y: 0 } },
            }
          : {}),
      } as DocumentRuntimeRequest;
    try {
      const protectedRequest = fixture.port.execute(request);
      await started.promise;
      const prepared = fixture.prepare(() => undefined);
      await Promise.resolve();
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(0);
      released.resolve();
      await protectedRequest;
      expect(await prepared).toMatchObject({ type: "prepare-scene-paths-success" });
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(256);
    } finally {
      released.resolve();
      run.mockRestore();
      fixture.close();
    }
  },
);

it.each([false, true])(
  "admits clipboard while a complete speculative batch waits for its scene ACK, bridge=%s",
  async (bridge) => {
    const fixture = await createScenePathProgressFixture(bridge, {
      speculative: true,
      initiallyBlocked: false,
    });
    const first = deferred();
    const acknowledgement = deferred();
    const batches: string[][] = [];
    try {
      const preparation = fixture.prepare((batch) => {
        batches.push(batch.paths.map(({ id }) => id));
        first.resolve();
        return acknowledgement.promise;
      });
      await first.promise;
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(256);
      expect(
        await fixture.port.execute({
          basisRevision: 0,
          identity: { ...identity, operationId: 3, purpose: "clipboard" },
          selectedIds: [fixture.ids[0]!],
          type: "clipboard-encode",
        }),
      ).toMatchObject({ type: "clipboard-encode-success" });
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(256);
      acknowledgement.resolve();
      expect(await preparation).toMatchObject({ type: "prepare-scene-paths-success", paths: [] });
      expect(fixture.sentIds(batches)).toEqual(fixture.ids);
    } finally {
      acknowledgement.resolve();
      fixture.close();
    }
  },
);

it.each(scenePathProgressCases("resume", "cancel", "terminate", "model"))(
  "suspends speculative geometry for queued clipboard and failed export work, bridge=%s, terminal=%s",
  async (bridge, terminal) => {
    const fixture = await createScenePathProgressFixture(bridge, { speculative: true });
    const first = deferred();
    const clipboardStarted = deferred();
    const releaseClipboard = deferred();
    const batches: string[][] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called on the actual runtime model.
    const original = DocumentModelRuntime.prototype.encodeClipboardSliced;
    const encode = vi.spyOn(DocumentModelRuntime.prototype, "encodeClipboardSliced");
    encode.mockImplementation(async function (this: DocumentModelRuntime, revision, ids, context) {
      clipboardStarted.resolve();
      await releaseClipboard.promise;
      return original.call(this, revision, ids, context);
    });
    try {
      const preparation = fixture
        .prepare((batch) => {
          batches.push(batch.paths.map(({ id }) => id));
          first.resolve();
        })
        .catch((error: unknown) => error);
      await first.promise;
      const clipboard = fixture.port
        .execute({
          basisRevision: 0,
          identity: { ...identity, operationId: 3, purpose: "clipboard" },
          selectedIds: [fixture.ids[0]!],
          type: "clipboard-encode",
        })
        .catch((error: unknown) => error);
      const exported = fixture.port
        .execute({
          ...identity,
          baseModelRevision: 0,
          exportGeneration: 1,
          modelRevision: 0,
          orderChanges: { content: [] },
          type: "export-incremental",
        })
        .catch((error: unknown) => error);
      const synchronized =
        terminal === "model"
          ? exported.then(() =>
              fixture.port.execute({
                baseModelRevision: 0,
                identity: { ...identity, operationId: 4, purpose: "clipboard" },
                modelRevision: 1,
                type: "model-sync-incremental",
              }),
            )
          : undefined;
      fixture.resume();
      await clipboardStarted.promise;
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(1);
      expect(batches.flat()).toEqual([fixture.ids[0]]);
      if (terminal === "cancel") fixture.port.cancelScenePreparation?.(identity);
      if (terminal === "terminate") fixture.close();
      releaseClipboard.resolve();
      if (terminal !== "terminate") {
        expect(await clipboard).toMatchObject({ type: "clipboard-encode-success" });
        expect(await exported).toMatchObject({ type: "export-failure" });
      } else {
        await clipboard;
        await exported;
      }
      const result = await preparation;
      if (synchronized !== undefined)
        expect(await synchronized).toMatchObject({ type: "model-sync-success", modelRevision: 1 });
      if (terminal === "resume") {
        expect(result).toMatchObject({ type: "prepare-scene-paths-success", paths: [] });
        expect(fixture.sentIds(batches)).toEqual(fixture.ids);
        expect(fixture.runtime.instrumentation.shapeBuilds).toBe(256);
      } else {
        expect(result).not.toMatchObject({ type: "prepare-scene-paths-success" });
        expect(batches.flat()).toEqual([fixture.ids[0]]);
      }
    } finally {
      releaseClipboard.resolve();
      encode.mockRestore();
      fixture.close();
    }
    expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
  },
);

it.each([false, true])(
  "offers the exact visible prefix before any overscan geometry without a CPU yield, bridge=%s",
  async (bridge) => {
    const fixture = await createScenePathProgressFixture(bridge, {
      visibleCount: 3,
      initiallyBlocked: false,
    });
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

it.each(scenePathProgressCases("complete", "cancel", "retarget"))(
  "keeps pending visible contours separate from capacity-sized overscan with one ACK, bridge=%s, terminal=%s",
  async (bridge, terminal) => {
    const fixture = await createScenePathProgressFixture(bridge, { visibleCount: 3 });
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
    const fixture = await createScenePathProgressFixture(bridge, { visibleCount: 3 });
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
