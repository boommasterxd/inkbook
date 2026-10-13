import { expect, it } from "vitest";

import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import {
  strokeLocalGeometry,
  translatedStroke,
} from "../../../../../src/domain/geometry/stroke-position";
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
import {
  IncrementalDocumentSerializer,
  serializeInkbookDocument,
} from "../../../../../src/persistence/serialization/public";
import { acceptPreparedPressurePaths } from "../../../../../src/persistence/worker/runtime/prepared-pressure-path-adoption";
import {
  DocumentWorkerRuntime,
  type DocumentRuntimeResult,
} from "../../../../../src/persistence/worker/runtime/public";
import {
  decodeRuntimeRequestChunked,
  encodeRuntimeRequest,
} from "../../../../../src/persistence/worker/runtime/wire-codec";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { unlockCanonicalSnapshot } from "../../../../fixtures/persistence/canonical-worker-unlock";
import { rectangle, snapshot } from "./fixtures";

const identity = { exportGeneration: 1, sessionId: "prepared-path", workerEpoch: 1 };

it("captures hint values before cooperative path validation can observe external mutation", async () => {
  const stroke = {
    ...pressureStroke(),
    points: Array.from({ length: 500 }, (_, index) => [30 + index, 20 + (index % 5), 0.5]).flat(),
  };
  const hint = { ...preparedHints(preparedStore(stroke), 1)[0]! };
  const document = { ...snapshot(1), elements: [stroke] };
  const request = createExportRequest(fullPlan(document), identity, () => [hint]);
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.reset(document).ok).toBe(true);
  let checkpoints = 0;
  try {
    await acceptPreparedPressurePaths(request, serializer, {
      signal: new AbortController().signal,
      checkpoint: () => {
        checkpoints += 1;
        Object.assign(hint, {
          d: "<invalid>",
          id: "changed",
          shapeKey: "changed",
          modelRevision: 99,
        });
        Object.assign(request, { modelRevision: 99 });
        return undefined;
      },
    });
    expect(checkpoints).toBeGreaterThan(0);
    expect(serializer.instrumentation.shapeCacheElements).toBe(1);
  } finally {
    serializer.clear();
  }
});

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
  store.pressureGeometry(stroke.id, record.geometryVersion).local!().publishPath?.(
    buildElementPathParts(strokeLocalGeometry(stroke)),
  );
  return store;
}

function preparedHints(store: ElementStore, revision: number) {
  return Array.from(store.preparedPressurePaths()).flatMap(({ record, parts }) => {
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

it("does not grant a scene hint to an externally frozen stroke header", () => {
  const source = pressureStroke();
  Object.freeze(source.points);
  Object.freeze(source);
  const stored = preparedStore(source).get(source.id)!;
  expect(
    preparedPressurePathHint({ ...stored, element: source }, [{ d: "M0 0", paint: "fill" }], 1),
  ).toBeUndefined();
});

function expectCanonicalExport(
  result: DocumentRuntimeResult,
  document: InkSnapshotV1,
): asserts result is Extract<DocumentRuntimeResult, { type: "export-success" }> {
  const canonical = serializeInkbookDocument(document);
  expect(result.type).toBe("export-success");
  if (result.type !== "export-success" || !canonical.ok) throw new Error("Export failed.");
  expect(result.outputHash).toBe(canonical.value.hash);
}

it.each([
  { offset: undefined, rotation: 0 },
  { offset: { x: 0, y: 0 }, rotation: 0 },
  { offset: { x: 12.007, y: 25.003 }, rotation: 37 },
  { offset: { x: -100.007, y: -0.003 }, rotation: 37 },
])(
  "reuses a current scene contour with $offset at $rotation degrees across the worker wire",
  async ({ offset, rotation }) => {
    const base = { ...pressureStroke(), rotation };
    const stroke = offset === undefined ? base : translatedStroke(base, offset);
    const store = preparedStore(stroke);
    const document = store.materializeSnapshot({ page: snapshot().page, revision: 1 });
    store.resetInstrumentation();
    const request = createExportRequest(fullPlan(document), identity, (revision) =>
      preparedHints(store, revision),
    );
    expect(request.preparedPressurePaths).toHaveLength(1);
    expect(store.instrumentation.fullStoreScans).toBe(0);
    const encoded = encodeRuntimeRequest(request);
    const decoded = await decodeRuntimeRequestChunked(encoded.value, {
      checkpoint: () => undefined,
      signal: new AbortController().signal,
    });
    if (decoded.type !== "export-full") throw new Error("Expected full export.");
    // The wire decoder supplies receiver-owned samples, as in production worker composition.
    const runtime = new DocumentWorkerRuntime(identity, null, undefined, true);
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
  },
);

it("transfers the retained local contour after movement and rejects the old shape header", async () => {
  const initial = { ...pressureStroke(), rotation: 37 };
  const store = preparedStore(initial);
  const oldHint = preparedHints(store, 1)[0]!;
  const original = store.get(initial.id)!.element as StrokeElementV1;
  store.replace(initial.id, translatedStroke(original, { x: -10.003, y: 0.007 }));
  const hints = preparedHints(store, 2);
  expect(hints).toHaveLength(1);
  expect(hints[0]).toMatchObject({ d: oldHint.d, shapeKey: oldHint.shapeKey, modelRevision: 2 });
  expect(hints[0]!.geometryVersion).not.toBe(oldHint.geometryVersion);
  const latest = store.materializeSnapshot({ page: snapshot().page, revision: 2 });
  const runtime = new DocumentWorkerRuntime(identity, null, undefined, true);
  const result = await runtime.execute(
    createExportRequest(fullPlan(latest), identity, () => hints),
  );
  expectCanonicalExport(result, latest);
  expect(runtime.instrumentation.shapeBuilds).toBe(0);
  runtime.terminate();
  const rejected = new DocumentWorkerRuntime(identity, null, undefined, true);
  const output = await rejected.execute(
    createExportRequest(fullPlan(latest), identity, () => [
      { ...hints[0]!, shapeKey: `${hints[0]!.shapeKey}:wrong` },
    ]),
  );
  expectCanonicalExport(output, latest);
  expect(rejected.instrumentation.shapeBuilds).toBe(1);
  rejected.terminate();
  store.releasePreparedPressureGeometry();
});

it("stops collecting lazy prepared hints at the receiver entry limit", () => {
  const store = preparedStore(pressureStroke());
  const hint = preparedHints(store, 1)[0]!;
  const document = store.materializeSnapshot({ page: snapshot().page, revision: 1 });
  let visits = 0;
  let closed = false;
  const request = createExportRequest(fullPlan(document), identity, function* () {
    try {
      for (let index = 0; index < 2_000; index++) {
        visits += 1;
        yield { ...hint, id: `hint-${index}`, d: "M0 0" };
      }
    } finally {
      closed = true;
    }
  });
  expect(visits).toBe(1_024);
  expect(request.preparedPressurePaths).toHaveLength(1_024);
  expect(closed).toBe(true);
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
