import { expect, it, vi } from "vitest";

import * as sampleCopy from "../../../../../../src/domain/elements/runtime-sample-copy";
import * as sampleValidation from "../../../../../../src/domain/schema/stroke-sample-range-validation";
import * as strokePosition from "../../../../../../src/domain/geometry/stroke-position";
import type { StrokeElementV1, StrokeSamplesV1 } from "../../../../../../src/domain/schema/public";
import type { RuntimeStrokeSamples } from "../../../../../../src/persistence/worker/runtime/model/runtime-elements";
import { adoptTransferredStrokeSamples } from "../../../../../../src/persistence/worker/runtime/model/runtime-elements";
import { FILE_SCHEMA_LIMITS } from "../../../../../../src/domain/schema/constants";
import { IncrementalDocumentSerializer } from "../../../../../../src/persistence/serialization/output/incremental-document-serializer";
import { DocumentModelRuntime } from "../../../../../../src/persistence/worker/runtime/model/document-model";
import { prepareModelUpdate } from "../../../../../../src/persistence/worker/runtime/model/model-update-preparation";
import type {
  ModelSyncRuntimeRequest,
  RuntimeSliceContext,
} from "../../../../../../src/persistence/worker/runtime/types";
import { createWorkerSnapshot } from "../../../../../fixtures/persistence/worker-snapshot";
import { executor, rectangleDocument, STROKE } from "../fixtures";

const identity = { ...executor, operationId: 1, purpose: "background" as const };

function longStroke(): StrokeElementV1 {
  return {
    ...STROKE,
    style: { ...STROKE.style },
    points: Array.from({ length: 4096 }, (_, index) => [index, index % 5, 0.5]).flat(),
  };
}

function context(
  checkpoint: () => Promise<void> | undefined,
  signal = new AbortController().signal,
): RuntimeSliceContext {
  return {
    checkpoint,
    signal,
    workProfile: { inputByteLimit: 256 * 24, nodeLimit: 256, outputByteLimit: 64 * 1024 },
  };
}

function update(stroke: StrokeElementV1): ModelSyncRuntimeRequest {
  return {
    baseModelRevision: 0,
    changedElements: [stroke],
    identity,
    modelRevision: 1,
    type: "model-sync-incremental",
  };
}

it("rejects aggregate sample capacity during native staging before allocating another buffer", async () => {
  const model = new DocumentModelRuntime(true);
  model.initialize(createWorkerSnapshot([STROKE]));
  const points = adoptTransferredStrokeSamples(
    new Float64Array(FILE_SCHEMA_LIMITS.pointsPerStroke * 3),
  );
  const count =
    Math.floor(FILE_SCHEMA_LIMITS.strokePoints / FILE_SCHEMA_LIMITS.pointsPerStroke) + 1;
  const elements = Array.from({ length: count }, (_, index) => ({
    ...STROKE,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    points,
  }));
  const allocate = vi.spyOn(sampleCopy, "allocateSampleCopy");
  const validation = vi.spyOn(sampleValidation, "assertStrokeSampleRange");
  try {
    await expect(
      model.synchronize(
        {
          baseModelRevision: null,
          identity,
          modelRevision: 1,
          snapshot: createWorkerSnapshot(elements, 1),
          type: "model-sync-full",
        },
        context(() => undefined),
      ),
    ).rejects.toThrow("Stroke point count exceeds");
    expect(allocate).not.toHaveBeenCalled();
    expect(validation).not.toHaveBeenCalled();
    expect(model.modelRevision).toBe(0);
    expect(model.encodeClipboard(0, [STROKE.id]).ok).toBe(true);
  } finally {
    allocate.mockRestore();
    validation.mockRestore();
    model.clear();
  }
});

it.each(["copy", "schema", "bounds"] as const)(
  "preserves the confirmed model when cancelled during %s",
  async (phase) => {
    const model = new DocumentModelRuntime();
    model.initialize(createWorkerSnapshot([STROKE]));
    const controller = new AbortController();
    const copy = vi.spyOn(sampleCopy, "copySampleRange");
    const validate = vi.spyOn(sampleValidation, "assertStrokeSampleRange");
    const bounds = vi.spyOn(strokePosition, "strokeWorldPoint");
    const observed = phase === "copy" ? copy : phase === "schema" ? validate : bounds;
    try {
      await expect(
        model.synchronize(
          update(longStroke()),
          context(() => {
            if (observed.mock.calls.length > 0) controller.abort();
            return undefined;
          }, controller.signal),
        ),
      ).rejects.toThrow();
      expect(observed).toHaveBeenCalled();
      expect(model.modelRevision).toBe(0);
      expect(model.instrumentation).toMatchObject({
        fragmentBuilds: 0,
        sampleEncodingBuilds: 0,
        shapeBuilds: 0,
      });
      expect(model.encodeClipboard(0, [STROKE.id]).ok).toBe(true);
      expect(() => model.encodeClipboard(1, [STROKE.id])).toThrow("basis-revision-mismatch");
    } finally {
      copy.mockRestore();
      validate.mockRestore();
      bounds.mockRestore();
      model.clear();
    }
  },
);

it("captures private headers and samples before validating the same candidate", async () => {
  const model = new DocumentModelRuntime();
  model.initialize(createWorkerSnapshot([STROKE]));
  const changed = longStroke();
  const points = changed.points;
  const validation = vi.spyOn(sampleValidation, "assertStrokeSampleRange");
  let mutated = false;
  try {
    await model.synchronize(
      update(changed),
      context(() => {
        if (!mutated && validation.mock.calls.length > 0) {
          points[0] = NaN;
          Object.assign(changed.style, { width: -1 });
          mutated = true;
        }
        return undefined;
      }),
    );
    expect(mutated).toBe(true);
    expect(model.modelRevision).toBe(1);
    const exported = await model.export({
      ...executor,
      baseModelRevision: 1,
      exportGeneration: 1,
      modelRevision: 1,
      type: "export-incremental",
    });
    expect(exported.ok).toBe(true);
    expect(model.encodeClipboard(1, [STROKE.id]).ok).toBe(true);
  } finally {
    validation.mockRestore();
    model.clear();
  }
});

it("keeps completed immutable point copies local until successful confirmation", async () => {
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.resetRuntime(createWorkerSnapshot([STROKE])).ok).toBe(true);
  const stroke = longStroke();
  Object.freeze(stroke.points);
  const pointCopies = new WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>();
  const publish = vi.spyOn(pointCopies, "set");
  const copy = vi.spyOn(sampleCopy, "copySampleRange");
  const controller = new AbortController();
  const validation = vi.spyOn(sampleValidation, "assertStrokeSampleRange");
  try {
    await expect(
      prepareModelUpdate({
        serializer,
        request: update(stroke),
        pointCopies,
        ownsSamples: false,
        context: context(() => {
          if (validation.mock.calls.length > 0) controller.abort();
          return undefined;
        }, controller.signal),
      }),
    ).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
    const beforeRetry = copy.mock.calls.length;
    const prepared = await prepareModelUpdate({
      serializer,
      request: update(stroke),
      pointCopies,
      ownsSamples: false,
      context: context(() => undefined),
    });
    expect(prepared.result.ok).toBe(true);
    expect(copy.mock.calls.length).toBeGreaterThan(beforeRetry);
    expect(publish).not.toHaveBeenCalled();
    prepared.confirm();
    prepared.discard();
    expect(publish).toHaveBeenCalledOnce();
    expect(pointCopies.has(stroke.points)).toBe(true);
  } finally {
    publish.mockRestore();
    copy.mockRestore();
    validation.mockRestore();
    serializer.clear();
  }
});

it("cancels staged order copying for 10,000 elements without adopting ranks or caches", async () => {
  const model = new DocumentModelRuntime();
  const baseline = rectangleDocument(10_000);
  model.initialize(baseline);
  const controller = new AbortController();
  let reads = 0;
  const order = new Proxy(baseline.elements.map(({ id }) => id).reverse(), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  await expect(
    model.synchronize(
      {
        baseModelRevision: 0,
        identity,
        modelRevision: 1,
        orderChanges: { content: order },
        type: "model-sync-incremental",
      },
      context(() => {
        if (reads >= 256) controller.abort();
        return undefined;
      }, controller.signal),
    ),
  ).rejects.toThrow();
  expect(reads).toBe(256);
  expect(model.modelRevision).toBe(0);
  expect(model.instrumentation).toMatchObject({ cacheElements: 0, fragmentBuilds: 0 });
  expect(model.encodeClipboard(0, [baseline.elements[0]!.id]).ok).toBe(true);
  model.clear();
});
