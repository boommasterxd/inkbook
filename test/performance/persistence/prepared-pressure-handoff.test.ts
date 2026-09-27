import { expect, it } from "vitest";

import { buildElementPathParts } from "../../../src/domain/geometry/element-path";
import { ElementStore } from "../../../src/domain/store/public";
import { AutosaveWorkerModelState } from "../../../src/persistence/saving/autosave/worker-model-state";
import {
  MAX_PREPARED_PRESSURE_HINT_BYTES,
  preparedPressurePathHint,
} from "../../../src/persistence/serialization/prepared-pressure-hints";
import { DocumentWorkerRuntime } from "../../../src/persistence/worker/runtime/public";
import { encodeRuntimeRequest } from "../../../src/persistence/worker/runtime/wire-codec";
import { unlockCanonicalSnapshot } from "../../fixtures/persistence/canonical-worker-unlock";
import { createPressureGroupFixture, createRetainedCapacityRectangle } from "./fixtures";

const identity = { exportGeneration: 1, sessionId: "prepared-work", workerEpoch: 1 };
const VISIBLE_STROKES = 32;

it("saves visible contour builds on a cold 10k-stroke unlock followed by an incremental draw", async () => {
  const baseline = createPressureGroupFixture();
  const runtime = new DocumentWorkerRuntime(identity);
  await unlockCanonicalSnapshot(runtime, baseline, identity);
  expect(runtime.instrumentation.shapeBuilds).toBe(0);

  const store = new ElementStore(baseline.elements);
  for (const element of baseline.elements.slice(0, VISIBLE_STROKES)) {
    if (element.kind !== "stroke") continue;
    const record = store.get(element.id)!;
    store
      .pressureGeometry(element.id, record.geometryVersion)
      .publishPath?.(buildElementPathParts(element));
  }
  const added = createRetainedCapacityRectangle(1_000_000);
  store.create(added);
  const model = new AutosaveWorkerModelState(baseline.revision);
  const source = {
    currentRevision: () => baseline.revision + 1,
    isGestureActive: () => false,
    orderByBand: () => ({ content: store.materializeBandOrder("content") }),
    preparedPressurePaths: (revision: number) =>
      store.preparedPressurePaths().flatMap(({ record, parts }) => {
        const hint = preparedPressurePathHint(record, parts, revision);
        return hint === undefined ? [] : [hint];
      }),
    snapshot: () =>
      store.materializeSnapshot({ page: baseline.page, revision: baseline.revision + 1 }),
  };
  store.resetInstrumentation();
  const request = model.createExportRequest(
    {
      baseModelRevision: baseline.revision,
      changedElements: [added],
      modelRevision: baseline.revision + 1,
      orderChanges: { content: store.materializeBandOrder("content") },
      removedIds: [],
      type: "incremental",
    },
    identity,
    source,
  );
  const hints = request.preparedPressurePaths ?? [];
  const serializedHintBytes = new TextEncoder().encode(JSON.stringify(hints)).byteLength;
  expect(hints).toHaveLength(VISIBLE_STROKES);
  expect(serializedHintBytes).toBeLessThanOrEqual(MAX_PREPARED_PRESSURE_HINT_BYTES);
  expect(store.instrumentation.fullStoreScans).toBe(0);
  expect(encodeRuntimeRequest(request).value.type).toBe("export-incremental-wire");

  const exported = await runtime.execute(request);
  expect(exported.type).toBe("export-success");
  expect(runtime.instrumentation.shapeBuilds).toBe(baseline.elements.length - VISIBLE_STROKES);
  expect(runtime.instrumentation.shapeCacheBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  runtime.terminate();
});
