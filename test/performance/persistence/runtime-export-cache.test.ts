import { describe, expect, it, vi } from "vitest";

import type { InkSnapshotV1 } from "../../../src/domain/schema/public";
import { IncrementalDocumentSerializer } from "../../../src/persistence/serialization/public";
import { createTestStroke, createWorkerSnapshot } from "../../fixtures/persistence/worker-snapshot";
import { createStandardPersistenceFixture, replaceFirstStroke, STANDARD_POINTS } from "./fixtures";
import { DocumentModelRuntime } from "../../../src/persistence/worker/runtime/document-model";
import {
  decodeRuntimeRequest,
  encodeRuntimeRequest,
} from "../../../src/persistence/worker/runtime/wire-codec";
import type { DocumentExportRequest } from "../../../src/persistence/worker/runtime/types";
import { SampleBase64Writer } from "../../../src/persistence/serialization/sample-base64";
import { CanonicalElementPathPreparation } from "../../../src/domain/geometry/canonical-element-path-preparation";
import { MAX_STROKE_POINTS } from "../../../src/domain/schema/constants";
import { createWorkerWorkScheduler } from "../../../src/persistence/worker/runtime/worker-work-scheduler";
import { ManualWorkerTiming } from "../../fixtures/persistence/manual-worker-timing";
import { adoptTransferredStrokeSamples } from "../../../src/persistence/worker/runtime/runtime-elements";

// Sequential scenarios share read-only samples; each serializer, proxy and scheduler is fresh.
const maximumStrokeSamples = Float64Array.from({ length: MAX_STROKE_POINTS * 3 }, (_, index) =>
  index % 3 === 0
    ? Math.floor(index / 3) / 10
    : index % 3 === 1
      ? (Math.floor(index / 3) % 7) / 1000
      : 0.5,
);

describe("runtime model synchronization performance", () => {
  it("synchronizes and restores 10,000 pressure strokes without export work", async () => {
    const stroke = createTestStroke();
    Object.freeze(stroke.points);
    const elements = Array.from({ length: 10_000 }, (_, index) => ({
      ...stroke,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    const model = new DocumentModelRuntime();
    const identity = {
      sessionId: "lazy-sync-capacity",
      workerEpoch: 1,
      operationId: 1,
      purpose: "background" as const,
    };
    model.synchronize({
      baseModelRevision: null,
      identity,
      modelRevision: 0,
      snapshot: createWorkerSnapshot(elements),
      type: "model-sync-full",
    });
    const append = vi.spyOn(SampleBase64Writer.prototype, "append");
    try {
      for (const [index, changedElements] of [
        elements.map((element) => ({ ...element, style: { ...element.style, opacity: 0.5 } })),
        elements,
      ].entries()) {
        model.synchronize({
          baseModelRevision: index,
          changedElements,
          identity,
          modelRevision: index + 1,
          type: "model-sync-incremental",
        });
        expect(model.instrumentation).toMatchObject({
          cacheElements: 0,
          fragmentBuilds: 0,
          sampleEncodingBuilds: 0,
          shapeBuilds: 0,
        });
        expect(append).not.toHaveBeenCalled();
      }
      const request = {
        sessionId: identity.sessionId,
        workerEpoch: identity.workerEpoch,
        baseModelRevision: 2,
        modelRevision: 2,
        exportGeneration: 1,
        type: "export-incremental" as const,
      };
      const cold = await model.export(request);
      expect(cold.ok).toBe(true);
      const warmed = model.instrumentation;
      append.mockClear();
      model.synchronize({
        baseModelRevision: 2,
        identity,
        modelRevision: 3,
        removedIds: elements.map((element) => element.id),
        type: "model-sync-incremental",
      });
      model.synchronize({
        baseModelRevision: 3,
        identity,
        modelRevision: 4,
        changedElements: elements,
        orderChanges: { content: elements.map((element) => element.id) },
        type: "model-sync-incremental",
      });
      expect(model.instrumentation.fragmentBuilds).toBe(warmed.fragmentBuilds);
      expect(model.instrumentation.shapeBuilds).toBe(warmed.shapeBuilds);
      expect(model.instrumentation.sampleEncodingCacheElements).toBe(0);
      expect(append).not.toHaveBeenCalled();
      expect((await model.export({ ...request, baseModelRevision: 4, modelRevision: 4 })).ok).toBe(
        true,
      );
      expect(model.instrumentation.shapeBuilds).toBe(warmed.shapeBuilds);
    } finally {
      append.mockRestore();
      model.clear();
    }
    expect(model.instrumentation).toMatchObject({
      cacheBytes: 0,
      sampleEncodingCacheBytes: 0,
      shapeCacheBytes: 0,
    });
  }, 120_000);
});

describe("runtime export cache performance", () => {
  it("bounds warm and one-element-change UTF-8 encoding across the 11,000-element fixture", async () => {
    const snapshot = createStandardPersistenceFixture();
    const { serializer, cold } = await warmSerializer(snapshot);
    const warmed = serializer.instrumentation;
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const encodeInto = vi.spyOn(TextEncoder.prototype, "encodeInto");
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    try {
      for (const changed of [undefined, replaceFirstStroke(snapshot, snapshot.revision + 1)]) {
        encode.mockClear();
        encodeInto.mockClear();
        decode.mockClear();
        if (changed !== undefined) {
          expect(
            serializer.applyDelta({
              baseModelRevision: snapshot.revision,
              changedElements: [{ ...changed, style: { ...changed.style, opacity: 0.5 } }],
              modelRevision: snapshot.revision + 1,
            }).ok,
          ).toBe(true);
          expect(serializer.instrumentation.fragmentBuilds).toBe(warmed.fragmentBuilds);
          expect(
            serializer.applyDelta({
              baseModelRevision: snapshot.revision + 1,
              changedElements: [changed],
              modelRevision: snapshot.revision + 2,
            }).ok,
          ).toBe(true);
          expect(serializer.instrumentation.fragmentBuilds).toBe(warmed.fragmentBuilds);
        }
        const result = await serializer.serializeRuntimeChunked({});
        if (!result.ok) throw new Error(result.error.code);
        if (changed === undefined) {
          expect(result.value.hash).toBe(cold.value.hash);
          expect(result.value.totalBytes).toBe(cold.value.totalBytes);
        }
        // The observed window includes delta application and complete output assembly.
        // Only the changed element, envelope and small background require text encoding.
        // Observe both encoder APIs so direct encodeInto assembly cannot hide a full pass.
        expect(encode.mock.calls.length).toBeLessThan(32);
        const encodedBytes = encode.mock.results.reduce(
          (sum, result) =>
            sum + (result.type === "return" ? (result.value as Uint8Array).byteLength : 0),
          0,
        );
        expect(encodedBytes).toBeLessThan(16 * 1024);
        expect(encodeInto).not.toHaveBeenCalled();
        expect(decode).not.toHaveBeenCalled();
        if (changed !== undefined) {
          expect(serializer.instrumentation.fragmentBuilds).toBe(warmed.fragmentBuilds + 1);
          expect(result.value.hash).not.toBe(cold.value.hash);
          expect(result.value.snapshot.revision).toBe(snapshot.revision + 2);
          // Verify parity outside the observed encoding window using the existing cache.
          encode.mockRestore();
          encodeInto.mockRestore();
          decode.mockRestore();
          const synchronous = serializer.serialize();
          if (!synchronous.ok) throw new Error(synchronous.error.code);
          expect(new TextDecoder().decode(result.value.svg)).toBe(synchronous.value.svg);
          expect(result.value.hash).toBe(synchronous.value.hash);
          expect(result.value.snapshotHash).toBe(synchronous.value.snapshotHash);
          expect(result.value.metadataBytes).toBe(synchronous.value.metadataBytes);
          expect(result.value.totalBytes).toBe(synchronous.value.totalBytes);
        }
      }
    } finally {
      encode.mockRestore();
      encodeInto.mockRestore();
      decode.mockRestore();
      serializer.clear();
    }
    expect(warmed.cacheElements).toBe(11_000);
    expect(warmed.cacheBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(serializer.instrumentation.fragmentBuilds).toBe(warmed.fragmentBuilds + 1);
    expect(serializer.instrumentation).toMatchObject({ cacheElements: 0, cacheBytes: 0 });
  }, 120_000);
});

it("adopts full-reset samples without encoding or decoding stroke metadata at document capacity", async () => {
  const snapshot = createStandardPersistenceFixture();
  const full: DocumentExportRequest = {
    baseModelRevision: null,
    exportGeneration: 1,
    modelRevision: snapshot.revision,
    sessionId: "full-reset-cache",
    snapshot,
    type: "export-full",
    workerEpoch: 1,
  };
  const same = decodeRuntimeRequest(encodeRuntimeRequest(full).value);
  const fresh = decodeRuntimeRequest(encodeRuntimeRequest({ ...full, exportGeneration: 2 }).value);
  if (same.type !== "export-full" || fresh.type !== "export-full")
    throw new Error("Expected full export.");
  let retainedPointReads = 0;
  same.snapshot.elements = same.snapshot.elements.map((element) =>
    element.kind === "stroke"
      ? {
          ...element,
          points: new Proxy(element.points, {
            get(target, key) {
              if (typeof key === "string" && /^\d+$/.test(key)) retainedPointReads += 1;
              const value: unknown = Reflect.get(target, key, target);
              return typeof value === "function" ? (value.bind(target) as unknown) : value;
            },
          }),
        }
      : element,
  );
  const runtime = new DocumentModelRuntime(true);
  const cold = await runtime.export(same);
  if (!cold.ok) throw new Error(cold.code);
  const warmed = runtime.instrumentation;
  const append = vi.spyOn(SampleBase64Writer.prototype, "append");
  const decode = vi.spyOn(TextDecoder.prototype, "decode");
  try {
    for (const request of [same, fresh]) {
      append.mockClear();
      decode.mockClear();
      retainedPointReads = 0;
      const result = await runtime.export(request);
      expect(result).toMatchObject({ ok: true, hash: cold.hash, totalBytes: cold.totalBytes });
      expect(append).not.toHaveBeenCalled();
      // Only the 1,000 non-stroke records retain the ordinary canonical-text comparison.
      expect(decode).toHaveBeenCalledTimes(1_000);
      expect(runtime.instrumentation.fragmentBuilds).toBe(warmed.fragmentBuilds);
      expect(runtime.instrumentation.shapeBuilds).toBe(warmed.shapeBuilds);
      // Fresh wire buffers require exactly one comparison read of each retained value.
      if (request === fresh) expect(retainedPointReads).toBe(STANDARD_POINTS * 3);
    }
    expect(runtime.instrumentation.fullValidationRuns).toBe(warmed.fullValidationRuns + 2);
    const firstStroke = fresh.snapshot.elements[0];
    if (firstStroke?.kind !== "stroke") throw new Error("Expected stroke.");
    const changed = { ...firstStroke, style: { ...firstStroke.style, opacity: 0.5 } };
    const latest = await runtime.export({
      ...full,
      baseModelRevision: full.modelRevision,
      changedElements: [changed],
      modelRevision: full.modelRevision + 1,
      type: "export-incremental",
    });
    if (!latest.ok) throw new Error(latest.code);
    append.mockClear();
    decode.mockClear();
    const result = await runtime.export({
      ...full,
      modelRevision: full.modelRevision + 1,
      snapshot: {
        ...fresh.snapshot,
        revision: full.modelRevision + 1,
        elements: [changed, ...fresh.snapshot.elements.slice(1)],
      },
    });
    expect(result).toMatchObject({ ok: true, hash: latest.hash });
    expect(append).not.toHaveBeenCalled();
    expect(decode).toHaveBeenCalledTimes(1_000);
  } finally {
    append.mockRestore();
    decode.mockRestore();
    runtime.clear();
  }
  expect(runtime.instrumentation).toMatchObject({
    cacheBytes: 0,
    cacheElements: 0,
    sampleEncodingCacheBytes: 0,
    shapeCacheBytes: 0,
  });
}, 120_000);

describe("runtime export background cache performance", () => {
  for (const type of ["lines", "squares", "dots"] as const) {
    it(`builds a 20,000-unit ${type} background once across repeated runtime exports`, async () => {
      const stroke = createTestStroke();
      const snapshot = createWorkerSnapshot([
        { ...stroke, pivot: { x: 15, y: 20_000 }, points: [10, 19_990, 0.5, 20, 20_000, 1] },
      ]);
      snapshot.page.background = { type, spacing: 25 };
      const { serializer, cold } = await warmSerializer(snapshot);
      for (let sample = 0; sample < 2; sample += 1) {
        const result = await serializer.serializeRuntimeChunked({});
        if (!result.ok) throw new Error(result.error.code);
        expect(result.value.hash).toBe(cold.value.hash);
      }
      expect(serializer.instrumentation.backgroundBuilds).toBe(1);
      expect(serializer.instrumentation.fragmentBuilds).toBe(1);
      serializer.clear();
    });
  }
});

async function warmSerializer(snapshot: InkSnapshotV1) {
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.resetRuntime(snapshot).ok).toBe(true);
  const cold = await serializer.serializeRuntimeChunked({});
  if (!cold.ok) throw new Error(cold.error.code);
  return { serializer, cold };
}

it.each(["export", "prewarm"] as const)(
  "bounds maximum-stroke %s work without forced handoffs while shared budget remains",
  async (operation) => {
    const fixture = longStrokeExportFixture();
    try {
      if (operation === "prewarm") {
        expect(await fixture.serializer.prewarmElementAtSliced(0, 0, fixture.context)).toBeNull();
        fixture.checkWork();
        expect(fixture.serializer.instrumentation).toMatchObject({
          cacheElements: 0,
          fragmentBuilds: 0,
        });
        expect(
          await fixture.serializer.prewarmElementAtSliced(0, 8 * 1024 * 1024, fixture.context),
        ).toBeGreaterThan(0);
      }
      const output = await fixture.serializer.serializeRuntimeChunked(fixture.context);
      if (!output.ok) throw new Error(output.error.code);
      fixture.checkWork();
      expect(fixture.counts()).toMatchObject({ waits: 0 });
      expect(fixture.counts().reads).toBeGreaterThanOrEqual(MAX_STROKE_POINTS * 3);
      expect(fixture.counts().operations).toBeGreaterThan(1);
      expect(fixture.serializer.instrumentation).toMatchObject({
        fragmentBuilds: 1,
        shapeBuilds: 1,
        sampleEncodingBuilds: 1,
      });
      const synchronous = fixture.serializer.serialize();
      if (!synchronous.ok) throw new Error(synchronous.error.code);
      expect(new TextDecoder().decode(output.value.svg)).toBe(synchronous.value.svg);
      expect(output.value.hash).toBe(synchronous.value.hash);
    } finally {
      fixture.dispose();
    }
  },
);

it.each(["encoding", "geometry"] as const)(
  "cancels maximum-stroke work at the central %s handoff before unfinished cache publication",
  async (stage) => {
    const fixture = longStrokeExportFixture(stage);
    try {
      const pending =
        stage === "encoding"
          ? fixture.serializer.serializeRuntimeChunked(fixture.context)
          : fixture.serializer.prewarmElementAtSliced(0, 8 * 1024 * 1024, fixture.context);
      expect(fixture.counts().waits).toBe(1);
      const completedReads = stage === "encoding" ? 0 : MAX_STROKE_POINTS * 3;
      expect(fixture.counts().reads).toBeGreaterThan(completedReads);
      expect(fixture.counts().reads).toBeLessThanOrEqual(completedReads + 768);
      expect(fixture.serializer.instrumentation).toMatchObject({
        cacheElements: 0,
        shapeCacheElements: 0,
        sampleEncodingCacheElements: stage === "encoding" ? 0 : 1,
      });
      const rejected = expect(pending).rejects.toThrow("cancelled");
      fixture.controller.abort(new Error("cancelled"));
      await rejected;
      expect(fixture.serializer.instrumentation).toMatchObject({
        fragmentBuilds: 0,
        shapeBuilds: 0,
      });
    } finally {
      fixture.dispose();
    }
  },
);

it("rejects a replaced model after a central prewarm handoff without retaining old fragments", async () => {
  const fixture = longStrokeExportFixture("geometry");
  try {
    const pending = fixture.serializer.prewarmElementAtSliced(0, 8 * 1024 * 1024, fixture.context);
    expect(fixture.counts().waits).toBe(1);
    expect(fixture.serializer.resetRuntime(createWorkerSnapshot([], 1), true).ok).toBe(true);
    const rejected = expect(pending).rejects.toThrow("model changed");
    await fixture.resume();
    await rejected;
    expect(fixture.serializer.currentRevision()).toBe(1);
    expect(fixture.serializer.currentElementCount()).toBe(0);
    expect(fixture.serializer.instrumentation).toMatchObject({
      cacheElements: 0,
      cacheBytes: 0,
      shapeCacheElements: 0,
      sampleEncodingCacheElements: 0,
    });
  } finally {
    fixture.dispose();
  }
});

function longStrokeExportFixture(initialStage: "none" | "encoding" | "geometry" = "none") {
  const timing = new ManualWorkerTiming();
  const { workScheduler } = createWorkerWorkScheduler(
    { sliceMilliseconds: 4, frameIntervalMilliseconds: 1000 / 120 },
    timing,
  );
  const controller = new AbortController();
  let active = false;
  let stage = initialStage;
  let reads = 0;
  let checkedReads = 0;
  let checkedOperations = 0;
  let waits = 0;
  const observed = new Proxy(maximumStrokeSamples, {
    get(target, key) {
      if (active && typeof key === "string" && /^\d+$/.test(key)) {
        reads += 1;
        if (stage === "encoding") timing.time = workScheduler.deadline();
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? (value.bind(target) as unknown) : value;
    },
  });
  const serializer = new IncrementalDocumentSerializer();
  expect(
    serializer.resetRuntime(
      createWorkerSnapshot([
        { ...createTestStroke(), points: adoptTransferredStrokeSamples(observed) },
      ]),
      true,
    ).ok,
  ).toBe(true);
  const step = Object.getOwnPropertyDescriptor(
    CanonicalElementPathPreparation.prototype,
    "stepOperation",
  )!.value as CanonicalElementPathPreparation["stepOperation"];
  const geometry = vi
    .spyOn(CanonicalElementPathPreparation.prototype, "stepOperation")
    .mockImplementation(function (this: CanonicalElementPathPreparation) {
      const complete = step.call(this);
      if (stage === "geometry") timing.time = workScheduler.deadline();
      return complete;
    });
  active = true;
  const checkWork = () => {
    // Encoding reads 256 triples; geometry prepares at most 65 smoothed centers per operation.
    expect(reads - checkedReads).toBeLessThanOrEqual(768);
    expect(geometry.mock.calls.length - checkedOperations).toBeLessThanOrEqual(1);
    checkedReads = reads;
    checkedOperations = geometry.mock.calls.length;
  };
  return {
    serializer,
    controller,
    checkWork,
    counts: () => ({ reads, waits, operations: geometry.mock.calls.length }),
    context: {
      signal: controller.signal,
      checkpoint: () => {
        checkWork();
        const pending = workScheduler.checkpoint(controller.signal);
        if (pending !== undefined) waits += 1;
        return pending;
      },
    },
    resume: async () => {
      stage = "none";
      for (let task = 0; task < 3 && timing.pendingMessages > 0; task += 1) {
        timing.runNextTask();
        await Promise.resolve();
      }
    },
    dispose: () => {
      geometry.mockRestore();
      serializer.clear();
      workScheduler.dispose();
      expect(timing.openPorts).toBe(0);
      expect(timing.pendingTimers).toBe(0);
      while (timing.pendingMessages > 0) timing.runNextTask();
      expect(timing.pendingMessages).toBe(0);
    },
  };
}
