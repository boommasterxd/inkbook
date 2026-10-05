import { expect, it, vi } from "vitest";
import { CanonicalElementPathPreparation } from "../../../../src/domain/geometry/canonical-element-path-preparation";
import * as pressureWindow from "../../../../src/domain/geometry/pressure-window";
import { IncrementalDocumentSerializer } from "../../../../src/persistence/serialization/incremental-document-serializer";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/document-runtime";
import {
  MAX_SCENE_PATH_BYTES,
  scenePathBytes,
} from "../../../../src/persistence/worker/runtime/scene-path-limits";
import { MAX_PREPARED_SCENE_PATH_IDS } from "../../../../src/domain/geometry/prepared-scene-paths";
import { RemoteScenePaths } from "../../../../src/rendering/scene/remote-scene-paths";
import { SceneMountPreparation } from "../../../../src/rendering/scene/scene-mount-preparation";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import { MountSlice } from "../../../../src/rendering/scene/mount-slice";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { MAX_STROKE_POINTS } from "../../../../src/domain/schema/public";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { strokeLocalGeometry } from "../../../../src/domain/geometry/stroke-position";
import { roundCanonical } from "../../../../src/domain/geometry/primitives";
import { observePointReads } from "../../../fixtures/rendering/point-reads";
import { asDocument, FakeDocument } from "../../../unit/rendering/scene/fakes";
import {
  createWorkerBridgeClient,
  createWorkerBridgeHarness,
} from "../../../fixtures/persistence/worker-bridge";
import type { SceneElementRecord, SceneStorePort } from "../../../../src/rendering/scene/types";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";

const RETARGET_IDENTITY = {
  operationId: 1,
  purpose: "background" as const,
  sessionId: "session-a",
  workerEpoch: 1,
};

it("prepares only three thousand visible contours of ten thousand in bounded worker batches", async () => {
  const identity = RETARGET_IDENTITY;
  const runtime = new DocumentWorkerRuntime(identity);
  const elements = Array.from({ length: 10_000 }, (_, index) => ({
    ...createTestStroke(),
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    style: { ...createTestStroke().style, pressureEnabled: index % 2 === 0 },
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
  const requestSizes: number[] = [];
  let reads = 0;
  let published = 0;
  let settle: Promise<unknown> | undefined;
  const store: SceneStorePort = {
    get: (id) => {
      reads++;
      return records.get(id);
    },
    query: () => undefined,
    prepareScenePaths: async (ids) => {
      requests++;
      requestSizes.push(ids.length);
      if (requests === 1) expect(ids).toHaveLength(1);
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
        result.paths.reduce((bytes, path) => bytes + scenePathBytes(path.id, path.parts), 0),
      ).toBeLessThanOrEqual(MAX_SCENE_PATH_BYTES);
      return result.paths;
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
  // A singleton and its lookahead fill the pool; subsequent refills use at least half.
  const minimumRefill = MAX_PREPARED_SCENE_PATH_IDS / 2;
  const maximumRequests = 2 + Math.ceil((published - MAX_PREPARED_SCENE_PATH_IDS) / minimumRefill);
  expect(requestSizes[1]).toBe(MAX_PREPARED_SCENE_PATH_IDS - 1);
  expect(requestSizes.slice(1, -1).every((count) => count >= minimumRefill)).toBe(true);
  expect(requestSizes.reduce((count, size) => count + size, 0)).toBe(published);
  expect(requests).toBeLessThanOrEqual(maximumRequests);
  expect(reads).toBeLessThanOrEqual(6000);
  expect(runtime.instrumentation.shapeBuilds).toBe(3000);
  preparation.cancel();
  expect(preparation.memoryUsage()).toBe(0);
  runtime.terminate();
  expect(runtime.instrumentation.shapeCacheBytes).toBe(0);
});

it("requests only cold contours among six hundred entrants and retains overlapping completion", async () => {
  const elements = Array.from({ length: 600 }, (_, rank) => ({
    ...createTestStroke(),
    id: `stroke-${rank}`,
  }));
  const records = new Map(
    elements.map((element, rank) => [
      element.id,
      {
        band: "content" as const,
        bounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
        element,
        geometryVersion: 0,
        id: element.id,
        paintVersion: 0,
        rank,
      },
    ]),
  );
  const cold = [0, 1, 500].map((index) => elements[index]!.id);
  const cached = new Set(elements.map((element) => element.id).filter((id) => !cold.includes(id)));
  let requested = 0;
  let wakes = 0;
  let finish!: () => void;
  let signal!: AbortSignal;
  const preparation = new RemoteScenePaths(
    {
      get: (id) => records.get(id),
      query: () => undefined,
      prepareScenePaths: (ids, cancellation) => {
        requested += ids.length;
        expect(ids.every((id) => !cached.has(id))).toBe(true);
        signal = cancellation;
        return new Promise((resolve) => {
          finish = () => resolve(ids.map((id) => ({ id, parts: [{ d: "M0 0Z", paint: "fill" }] })));
        });
      },
    },
    {
      isCached: (record) => cached.has(record.id),
      onPrepared: (record) => {
        cached.add(record.id);
      },
      onReady: () => {
        wakes++;
      },
    },
  );
  const first = records.get(cold[0]!)!;
  const upcoming = () => elements.slice(1).map((element) => element.id);
  expect(preparation.read(first, upcoming)).toBe("pending");
  preparation.cancel(() => true);
  finish();
  await Promise.resolve();
  expect(preparation.waiting).toBe(false);
  expect(preparation.read(first, upcoming)).toEqual([{ d: "M0 0Z", paint: "fill" }]);
  expect(preparation.waiting).toBe(true);
  preparation.cancel(() => true);
  expect(signal.aborted).toBe(false);
  finish();
  await Promise.resolve();
  expect(preparation.waiting).toBe(false);
  for (const id of cold.slice(1))
    expect(preparation.read(records.get(id)!, () => [])).toEqual([{ d: "M0 0Z", paint: "fill" }]);
  expect(requested).toBe(3);
  expect(wakes).toBe(2);
  expect(cached.size).toBe(600);
  preparation.cancel();
  expect(preparation.memoryUsage()).toBe(0);
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
  let wakes = 0;
  const store: SceneStorePort = {
    get: () => record,
    query: () => undefined,
    prepareScenePaths: (_, cancellation) => {
      signal = cancellation;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const preparation = new RemoteScenePaths(store, {
    onReady: () => {
      wakes++;
    },
  });
  expect(preparation.read(record, () => [])).toBe("pending");
  preparation.cancel();
  expect(signal?.aborted).toBe(true);
  finish([{ id: record.id, parts: [{ d: "M0 0Z", paint: "fill" }] }]);
  await Promise.resolve();
  expect(preparation.memoryUsage()).toBe(0);
  expect(wakes).toBe(0);
  expect(preparation.read(record, () => [])).toBe("pending");
  finish([{ id: record.id, parts: [{ d: "M0 0Z", paint: "fill" }] }]);
  await Promise.resolve();
  expect(wakes).toBe(1);
  expect(preparation.read({ ...record, geometryVersion: 1 }, () => [])).toBeUndefined();
  preparation.cancel();
  expect(
    new RemoteScenePaths({ get: () => record, query: () => undefined }).read(record, () => []),
  ).toBeUndefined();
  const failed = new RemoteScenePaths(
    { ...store, prepareScenePaths: () => Promise.reject(new Error("unavailable")) },
    {
      onReady: () => {
        wakes++;
      },
    },
  );
  expect(failed.read(record, () => [])).toBe("pending");
  await Promise.resolve();
  expect(failed.waiting).toBe(false);
  expect(failed.read(record, () => [])).toBeUndefined();
  expect(failed.memoryUsage()).toBe(0);
  expect(wakes).toBe(2);
});

it("mounts a maximum plain stroke with worker geometry and zero main-thread sample reads or builds", async () => {
  const fixture = maximumPlainMount();
  const identity = {
    operationId: 1,
    purpose: "background" as const,
    sessionId: "session-a",
    workerEpoch: 1,
  };
  const harness = createWorkerBridgeHarness();
  const port = createWorkerBridgeClient(harness.clientEndpoint);
  await port.execute({
    baseModelRevision: null,
    identity,
    modelRevision: 0,
    snapshot: createWorkerSnapshot([fixture.original]),
    type: "model-sync-full",
  });
  let settle: Promise<unknown> | undefined;
  let requests = 0;
  fixture.store.prepareScenePaths = async (ids) => {
    requests++;
    const pending = port.execute({ basisRevision: 0, identity, ids, type: "prepare-scene-paths" });
    settle = pending;
    const result = await pending;
    if (result.type !== "prepare-scene-paths-success") throw new Error("Preparation failed.");
    return result.paths;
  };
  const slice = new MountSlice(Infinity, () => 0);
  expect(fixture.preparation.stage(fixture.record, slice, undefined)).toBeUndefined();
  await settle;
  await Promise.resolve();
  const entry = fixture.preparation.stage(fixture.record, slice, undefined)!;
  expect(entry.pathParts).toEqual(buildElementPathParts(strokeLocalGeometry(fixture.original)));
  expect(entry.paths[0]!.node.getAttribute("transform")).toBe("translate(30 40)");
  expect(entry.paths[0]!.node.getAttribute("stroke-width")).toBe("2");
  expect(entry.paths[0]!.node.getAttribute("class")).toBe("inkbook-theme-stroke");
  expect(entry.paths[0]!.node.getAttribute("fill")).toBe("none");
  expect(fixture.preparation.stage(fixture.record, slice, undefined)?.pathParts).toBe(
    entry.pathParts,
  );
  expect(requests).toBe(1);
  expect(fixture.reads()).toBe(0);
  expect(fixture.cache.statistics().builds).toBe(0);
  expect(harness.runtime.instrumentation.shapeBuilds).toBe(1);
  fixture.preparation.cancel();
  fixture.cache.release();
  port.terminate();
  harness.detach();
  expect(fixture.preparation.memoryUsage()).toBe(0);
  expect(fixture.cache.statistics().entries).toBe(0);
  expect(harness.runtime.instrumentation.shapeCacheBytes).toBe(0);
});

it("bounds local plain-stroke fallback steps and releases cancelled scratch before restart", () => {
  const fixture = maximumPlainMount();
  const slice = new MountSlice(1, fixture.reads);
  expect(fixture.preparation.stage(fixture.record, slice, undefined)).toBeUndefined();
  expect(fixture.reads()).toBeGreaterThan(0);
  expect(fixture.reads()).toBeLessThanOrEqual(65 * 12);
  expect(fixture.preparation.pendingId).toBe(fixture.record.id);
  expect(fixture.preparation.memoryUsage()).toBeGreaterThan(0);
  fixture.preparation.cancel();
  expect(fixture.preparation.memoryUsage()).toBe(0);
  expect(fixture.cache.statistics().entries).toBe(0);
  const entry = fixture.preparation.stage(
    fixture.record,
    new MountSlice(Infinity, () => 0),
    undefined,
  )!;
  expect(entry.pathParts).toEqual(buildElementPathParts(strokeLocalGeometry(fixture.original)));
  expect(fixture.cache.statistics().builds).toBe(2);
  const reads = fixture.reads();
  expect(
    fixture.preparation.stage(fixture.record, new MountSlice(Infinity, () => 0), undefined)
      ?.pathParts,
  ).toBe(entry.pathParts);
  expect(fixture.reads()).toBe(reads);
  fixture.preparation.cancel();
  fixture.cache.release();
  expect(fixture.preparation.memoryUsage()).toBe(0);
});

it.each([false, true])(
  "stops a suspended maximum contour before more real geometry work, pressure=%s",
  async (pressureEnabled) => {
    const identity = RETARGET_IDENTITY;
    const maximum = maximumPlainMount().original;
    const target = { ...maximum, style: { ...maximum.style, pressureEnabled } };
    const first = { ...createTestStroke(), id: "00000000-0000-4000-8000-000000000002" };
    const last = { ...first, id: "00000000-0000-4000-8000-000000000003" };
    let currentId: string | undefined;
    let targetMemory!: () => number;
    let targetSteps = 0;
    let unionStarted = false;
    let block = true;
    const admission = deferred();
    const handoff = deferred();
    // Original methods are invoked with the actual instance through call().
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked through call with the actual serializer instance.
    const prepare = IncrementalDocumentSerializer.prototype.prepareScenePath;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked through call with the actual geometry instance.
    const step = CanonicalElementPathPreparation.prototype.stepOperation;
    const union = pressureWindow.preparePressureWindowSteps;
    const spies = [
      vi
        .spyOn(IncrementalDocumentSerializer.prototype, "prepareScenePath")
        .mockImplementation(async function (this: IncrementalDocumentSerializer, id, context) {
          currentId = id;
          try {
            return await prepare.call(this, id, context);
          } finally {
            currentId = undefined;
          }
        }),
      vi
        .spyOn(CanonicalElementPathPreparation.prototype, "stepOperation")
        .mockImplementation(function (this: CanonicalElementPathPreparation) {
          if (currentId === target.id) {
            targetSteps++;
            targetMemory = () => this.memoryUsage();
          }
          return step.call(this);
        }),
      vi.spyOn(pressureWindow, "preparePressureWindowSteps").mockImplementation((pieces) => {
        if (currentId === target.id) unionStarted = true;
        return union(pieces);
      }),
    ];
    const runtime = new DocumentWorkerRuntime(identity, {
      checkpoint: () => {
        if (
          !block ||
          currentId !== target.id ||
          (pressureEnabled ? !unionStarted : targetSteps === 0)
        )
          return undefined;
        admission.resolve();
        return handoff.promise;
      },
      run: async (operation, signal) => operation(signal),
    });
    try {
      await runtime.execute({
        baseModelRevision: null,
        identity,
        modelRevision: 0,
        snapshot: createWorkerSnapshot([first, target, last]),
        type: "model-sync-full",
      });
      const progress: string[] = [];
      const pending = runtime.execute(
        {
          basisRevision: 0,
          identity,
          ids: [first.id, target.id, last.id],
          streamProgress: true,
          type: "prepare-scene-paths",
        },
        {
          unlockBatch: () => undefined,
          scenePaths: (batch) => {
            progress.push(...batch.paths.map(({ id }) => id));
          },
        },
      );
      await admission.promise;
      expect(progress).toEqual([first.id]);
      expect(targetMemory()).toBeGreaterThan(0);
      expect(runtime.instrumentation.shapeBuilds).toBe(1);
      const steps = targetSteps;
      runtime.retargetScenePreparation(identity, [first.id, last.id]);
      block = false;
      handoff.resolve();
      expect(await pending).toMatchObject({ paths: [] });
      expect(targetSteps).toBe(steps);
      expect(progress).toEqual([first.id, last.id]);
      expect(targetMemory()).toBe(0);
      expect(runtime.instrumentation.shapeBuilds).toBe(2);
    } finally {
      runtime.terminate();
      for (const spy of spies) spy.mockRestore();
    }
  },
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

function maximumPlainMount() {
  const base = createTestStroke();
  const points = Array.from({ length: MAX_STROKE_POINTS }, (_, index) => [
    10 + (index % 100),
    roundCanonical(10 + Math.sin(index)),
    0.5,
  ]).flat();
  Object.freeze(points);
  const original = {
    ...base,
    points,
    offset: { x: 30, y: 40 },
    pivot: { x: 40, y: 50 },
    style: { ...base.style, pressureEnabled: false },
  };
  let reads = 0;
  const record: SceneElementRecord = {
    element: {
      ...original,
      points: observePointReads(points, () => {
        reads++;
      }),
    },
    geometryVersion: 0,
    id: original.id,
    paintVersion: 0,
    band: "content",
    rank: 0,
    bounds: { minX: 0, minY: 0, maxX: 200, maxY: 200 },
  };
  const cache = new ScenePathCache();
  const store: SceneStorePort = { get: () => record, query: () => undefined };
  const preparation = new SceneMountPreparation({
    ownerDocument: asDocument(new FakeDocument()),
    instrumentation: createInstrumentation(),
    pathCache: cache,
    store,
  });
  return { cache, original, preparation, reads: () => reads, record, store };
}
