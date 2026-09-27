import { expect, it } from "vitest";

import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { translatedStroke } from "../../../../../src/domain/geometry/stroke-position";
import type { InkSnapshotV1, StrokeElementV1 } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { PreparedPressurePathCache } from "../../../../../src/domain/store/prepared-pressure-path-cache";
import { createExportRequest } from "../../../../../src/persistence/saving/autosave/export-request";
import { AutosaveWorkerModelState } from "../../../../../src/persistence/saving/autosave/worker-model-state";
import {
  MAX_PREPARED_PRESSURE_HINT_BYTES,
  preparedPressureHintBytes,
  preparedPressurePathHint,
} from "../../../../../src/persistence/serialization/prepared-pressure-hints";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import {
  DocumentWorkerRuntime,
  type DocumentRuntimeResult,
} from "../../../../../src/persistence/worker/runtime/public";
import {
  decodeRuntimeRequest,
  encodeRuntimeRequest,
} from "../../../../../src/persistence/worker/runtime/wire-codec";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { unlockCanonicalSnapshot } from "../../../../fixtures/persistence/canonical-worker-unlock";
import { rectangle, snapshot } from "./fixtures";

const identity = { exportGeneration: 1, sessionId: "prepared-path", workerEpoch: 1 };

function pressureStroke(): StrokeElementV1 {
  const base = indexedStroke(1);
  return {
    ...base,
    pivot: { x: 74.5, y: 22 },
    points: Array.from({ length: 90 }, (_, index) => [
      30 + index,
      20 + (index % 5),
      (2 + (index % 7)) / 10,
    ]).flat(),
  };
}

function preparedStore(stroke: StrokeElementV1) {
  const store = new ElementStore([stroke]);
  const record = store.get(stroke.id)!;
  store
    .pressureGeometry(stroke.id, record.geometryVersion)
    .publishPath?.(buildElementPathParts(stroke));
  return store;
}

function preparedHints(store: ElementStore, revision: number) {
  return store.preparedPressurePaths().flatMap(({ record, parts }) => {
    const hint = preparedPressurePathHint(record, parts, revision);
    return hint === undefined ? [] : [hint];
  });
}

function fullPlan(document: InkSnapshotV1) {
  return {
    baseModelRevision: null,
    modelRevision: document.revision,
    snapshot: document,
    type: "full" as const,
  };
}

function expectCanonicalExport(
  result: DocumentRuntimeResult,
  document: InkSnapshotV1,
): asserts result is Extract<DocumentRuntimeResult, { type: "export-success" }> {
  const canonical = serializeInkbookDocument(document);
  expect(result.type).toBe("export-success");
  if (result.type !== "export-success" || !canonical.ok) throw new Error("Export failed.");
  expect(result.outputHash).toBe(canonical.value.hash);
}

it("reuses a current scene contour across the worker wire with canonical output", async () => {
  const stroke = pressureStroke();
  const store = preparedStore(stroke);
  const document = store.materializeSnapshot({ page: snapshot().page, revision: 1 });
  store.resetInstrumentation();
  const request = createExportRequest(fullPlan(document), identity, (revision) =>
    preparedHints(store, revision),
  );
  expect(request.preparedPressurePaths).toHaveLength(1);
  expect(store.instrumentation.fullStoreScans).toBe(0);
  const encoded = encodeRuntimeRequest(request);
  const decoded = decodeRuntimeRequest(encoded.value);
  if (decoded.type !== "export-full") throw new Error("Expected full export.");
  const runtime = new DocumentWorkerRuntime(identity);
  const result = await runtime.execute(decoded);
  expectCanonicalExport(result, document);
  expect(runtime.instrumentation.shapeBuilds).toBe(0);
  expect(runtime.instrumentation.shapeCacheBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  runtime.acknowledgeExport(result, true);

  const moved = translatedStroke(decoded.snapshot.elements[0] as StrokeElementV1, {
    x: 5,
    y: 8,
  });
  const changed = await runtime.execute({
    ...identity,
    baseModelRevision: 1,
    changedElements: [moved],
    exportGeneration: 2,
    modelRevision: 2,
    type: "export-incremental",
  });
  expect(changed.type).toBe("export-success");
  expect(runtime.instrumentation.shapeBuilds).toBe(0);
  runtime.terminate();
});

it("rejects stale same-length geometry, old revisions, and malformed paths", async () => {
  const stroke = pressureStroke();
  const store = preparedStore(stroke);
  const oldHint = preparedHints(store, 1)[0]!;
  store.replace(stroke.id, {
    ...stroke,
    points: stroke.points.map((value, index) => (index === 3 ? value + 1 : value)),
  });
  expect(preparedHints(store, 2)).toEqual([]);
  const document = store.materializeSnapshot({ page: snapshot().page, revision: 2 });
  const runtime = new DocumentWorkerRuntime(identity);
  const result = await runtime.execute({
    ...identity,
    baseModelRevision: null,
    modelRevision: 2,
    preparedPressurePaths: [oldHint, { ...oldHint, modelRevision: 2, d: "<script>" }],
    snapshot: document,
    type: "export-full",
  });
  expect(result.type).toBe("export-success");
  expect(runtime.instrumentation.shapeBuilds).toBe(1);
  runtime.terminate();
});

it("seeds changed pressure geometry before incremental fragment construction", async () => {
  const initial = pressureStroke();
  const store = preparedStore(initial);
  const first = store.materializeSnapshot({ page: snapshot().page, revision: 1 });
  const runtime = new DocumentWorkerRuntime(identity);
  const original = await runtime.execute(
    createExportRequest(fullPlan(first), identity, (revision) => preparedHints(store, revision)),
  );
  expect(original.type).toBe("export-success");
  expect(runtime.instrumentation.shapeBuilds).toBe(0);

  const changed = {
    ...initial,
    points: initial.points.map((value, index) => (index === 3 ? value + 1 : value)),
  };
  store.replace(initial.id, changed);
  const record = store.get(initial.id)!;
  store
    .pressureGeometry(initial.id, record.geometryVersion)
    .publishPath?.(buildElementPathParts(changed));
  const latest = store.materializeSnapshot({ page: first.page, revision: 2 });
  const request = createExportRequest(
    {
      baseModelRevision: 1,
      changedElements: [latest.elements[0]!],
      modelRevision: 2,
      orderChanges: {},
      removedIds: [],
      type: "incremental",
    },
    { ...identity, exportGeneration: 2 },
    (revision) => preparedHints(store, revision),
  );
  expect(request.preparedPressurePaths).toHaveLength(1);
  const result = await runtime.execute(request);
  expectCanonicalExport(result, latest);
  expect(runtime.instrumentation.shapeBuilds).toBe(0);
  runtime.terminate();
});

it("reuses unchanged visible geometry on the first draw export after cold unlock", async () => {
  const stroke = pressureStroke();
  const store = preparedStore(stroke);
  const baseline = store.materializeSnapshot({ page: snapshot().page, revision: 1 });
  const runtime = new DocumentWorkerRuntime(identity);
  await unlockCanonicalSnapshot(runtime, baseline, identity);
  expect(runtime.instrumentation.shapeBuilds).toBe(0);

  const added = rectangle();
  store.create(added);
  const latest = store.materializeSnapshot({ page: baseline.page, revision: 2 });
  const request = createExportRequest(
    {
      baseModelRevision: 1,
      changedElements: [added],
      modelRevision: 2,
      orderChanges: { content: store.materializeBandOrder("content") },
      removedIds: [],
      type: "incremental",
    },
    identity,
    (revision) => preparedHints(store, revision),
    true,
  );
  expect(request.preparedPressurePaths).toHaveLength(1);
  expect(request).toMatchObject({ includeBaselinePreparedPressurePaths: true });
  const exported = await runtime.execute(request);
  expectCanonicalExport(exported, latest);
  expect(runtime.instrumentation.shapeBuilds).toBe(0);
  runtime.terminate();
});

it("offers baseline paths until export acknowledgement and again after epoch reset", () => {
  const stroke = pressureStroke();
  const store = preparedStore(stroke);
  const model = new AutosaveWorkerModelState(1);
  const document = store.materializeSnapshot({ page: snapshot().page, revision: 2 });
  const source = {
    currentRevision: () => 2,
    isGestureActive: () => false,
    orderByBand: () => ({ content: [stroke.id] }),
    preparedPressurePaths: (revision: number) => preparedHints(store, revision),
    snapshot: () => document,
  };
  const plan = {
    baseModelRevision: 1,
    changedElements: [rectangle()],
    modelRevision: 2,
    orderChanges: {},
    removedIds: [],
    type: "incremental" as const,
  };
  expect(model.createExportRequest(plan, identity, source).preparedPressurePaths).toHaveLength(1);
  model.acknowledgeExport(2);
  expect(model.createExportRequest(plan, identity, source).preparedPressurePaths).toBeUndefined();
  model.resetPreparedPathBaseline();
  expect(model.createExportRequest(plan, identity, source).preparedPressurePaths).toHaveLength(1);
});

it("bounds the cache index and export hint bytes without retaining removed entries", () => {
  const cache = new PreparedPressurePathCache(200, 1);
  cache.publish("a", 1, [{ d: "M0 0", paint: "fill" }]);
  cache.publish("b", 1, [{ d: "M1 1", paint: "fill" }]);
  expect([...cache.cachedVersions()]).toEqual([["b", 1]]);
  cache.invalidate("b");
  expect([...cache.cachedVersions()]).toEqual([]);
  cache.publish("c", 2, [{ d: "M2 2", paint: "fill" }]);
  const manyChangedIds = new Set(Array.from({ length: 20_000 }, (_, index) => `id-${index}`));
  manyChangedIds.add("c");
  Object.defineProperty(manyChangedIds, Symbol.iterator, {
    value: () => {
      throw new Error("Large changed-ID sets must not be scanned for cached paths.");
    },
  });
  expect([...cache.versionsFor(manyChangedIds)]).toEqual([["c", 2]]);
  cache.setRetentionEnabled(false);
  expect([...cache.cachedVersions()]).toEqual([]);

  const stroke = pressureStroke();
  const document = { ...snapshot(1), elements: [stroke] };
  const base = { ...preparedHints(preparedStore(stroke), 1)[0]!, d: "M0 0".repeat(120_000) };
  const request = createExportRequest(fullPlan(document), identity, () =>
    Array.from({ length: 6 }, (_, index) => ({ ...base, id: `${base.id}-${index}` })),
  );
  const bytes = request.preparedPressurePaths!.reduce(
    (total, hint) => total + preparedPressureHintBytes(hint),
    0,
  );
  expect(bytes).toBeLessThanOrEqual(MAX_PREPARED_PRESSURE_HINT_BYTES);
  expect(request.preparedPressurePaths!.length).toBeLessThan(6);
  let reads = 0;
  const orderOnly = createExportRequest(
    {
      baseModelRevision: 1,
      changedElements: [],
      modelRevision: 2,
      orderChanges: { content: [stroke.id] },
      removedIds: [],
      type: "incremental",
    },
    identity,
    () => {
      reads += 1;
      return [];
    },
  );
  expect(orderOnly.preparedPressurePaths).toBeUndefined();
  expect(reads).toBe(0);
});

it("does not seed geometry after cancellation", async () => {
  const stroke = pressureStroke();
  const store = preparedStore(stroke);
  const document = store.materializeSnapshot({ page: snapshot().page, revision: 1 });
  const request = createExportRequest(fullPlan(document), identity, (revision) =>
    preparedHints(store, revision),
  );
  const controller = new AbortController();
  controller.abort();
  const { DocumentModelRuntime } =
    await import("../../../../../src/persistence/worker/runtime/document-model");
  const model = new DocumentModelRuntime();
  const result = await model.export(request, {
    checkpoint: async () => undefined,
    signal: controller.signal,
  });
  expect(result.ok).toBe(false);
  expect(model.instrumentation.shapeCacheElements).toBe(0);
});
