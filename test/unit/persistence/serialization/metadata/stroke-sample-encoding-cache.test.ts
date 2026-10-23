import { describe, expect, it } from "vitest";
import { StrokeSampleEncodingCache } from "../../../../../src/persistence/serialization/metadata/stroke-sample-encoding-cache";
import { encodeStrokeSamples } from "../../../../../src/persistence/serialization/metadata/stroke-sample-codec";
import { ChunkedInkbookInputParser } from "../../../../../src/persistence/serialization/input/chunked-input-codec";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import { DocumentModelRuntime } from "../../../../../src/persistence/worker/runtime/model/document-model";
import { adoptTransferredStrokeSamples } from "../../../../../src/persistence/worker/runtime/model/runtime-elements";
import { IncrementalDocumentSerializer } from "../../../../../src/persistence/serialization/output/incremental-document-serializer";
import {
  createTestStroke,
  createMultiWindowPressureStroke,
  createWorkerSnapshot,
} from "../../../../fixtures/persistence/worker-snapshot";
import { rectangle } from "../../worker/runtime/fixtures";
import { finishGeometrySteps } from "../../../../fixtures/domain/geometry-steps";

describe("sample ownership during cooperative encoding", () => {
  it("rechecks current ownership after encoding and preserves a replacement cache entry", () => {
    const base = createMultiWindowPressureStroke();
    const stroke = { ...base, points: [...base.points, ...base.points] };
    let current = stroke;
    const cache = new StrokeSampleEncodingCache((candidate) => candidate === current);
    const steps = cache.resolveSteps(stroke);
    expect(steps.next().done).toBe(false);
    current = { ...stroke, points: [...stroke.points] };
    const replacement = cache.resolve(current);
    expect(finishGeometrySteps(steps)).toBe(replacement);
    expect(cache.resolve(current)).toBe(replacement);
    expect(cache.instrumentation).toMatchObject({
      sampleEncodingBuilds: 2,
      sampleEncodingHits: 1,
      sampleEncodingCacheElements: 1,
    });
    const unowned = cache.resolveSteps(stroke);
    expect(finishGeometrySteps(unowned)).toBe(replacement);
    expect(cache.resolve(current)).toBe(replacement);
    expect(cache.instrumentation).toMatchObject({
      sampleEncodingBuilds: 3,
      sampleEncodingHits: 2,
      sampleEncodingCacheElements: 1,
    });
  });
});

describe("retired sample encoding ownership", () => {
  it("retires only owned typed samples and requires current ownership for restoration", () => {
    const base = createTestStroke();
    const stroke = {
      ...base,
      points: adoptTransferredStrokeSamples(new Float64Array(base.points)),
    };
    let owned = true;
    const cache = new StrokeSampleEncodingCache(() => owned);
    const encoding = cache.resolve(stroke);
    const bytes = cache.instrumentation.sampleEncodingCacheBytes;
    cache.retire(stroke);
    expect(cache.instrumentation.sampleEncodingCacheBytes).toBe(bytes);
    cache.reconcileElement({ ...stroke, offset: { x: 3, y: 4 } });
    expect(cache.resolve(stroke)).toBe(encoding);
    expect(cache.instrumentation.sampleEncodingBuilds).toBe(1);
    cache.retire(stroke);
    owned = false;
    expect(cache.resolve(stroke)).toBe(encoding);
    expect(cache.instrumentation).toMatchObject({
      sampleEncodingBuilds: 2,
      sampleEncodingHits: 1,
      sampleEncodingCacheElements: 0,
    });
    owned = true;
    cache.resolve(base);
    cache.retire(base);
    expect(cache.instrumentation.sampleEncodingCacheElements).toBe(0);
    cache.resolve(stroke);
    owned = false;
    cache.retire(stroke);
    cache.retire(undefined);
    expect(cache.instrumentation.sampleEncodingCacheBytes).toBe(0);
  });

  it("drops retired entries on reset, changed identity, eviction and clear", () => {
    const base = createTestStroke();
    const stroke = {
      ...base,
      points: adoptTransferredStrokeSamples(new Float64Array(base.points)),
    };
    const cache = new StrokeSampleEncodingCache(() => true);
    cache.resolve(stroke);
    cache.retire(stroke);
    cache.reconcile(createWorkerSnapshot([stroke]));
    expect(cache.instrumentation.sampleEncodingCacheElements).toBe(0);
    cache.resolve(stroke);
    cache.retire(stroke);
    cache.reconcileElement({
      ...stroke,
      points: adoptTransferredStrokeSamples(new Float64Array(stroke.points)),
    });
    expect(cache.instrumentation.sampleEncodingCacheElements).toBe(0);
    cache.resolve(stroke);
    cache.retire(stroke);
    cache.retainDecoded("large", stroke.points, "A".repeat(16 * 1024 * 1024 - 100));
    expect(cache.instrumentation.sampleEncodingCacheElements).toBe(1);
    const builds = cache.instrumentation.sampleEncodingBuilds;
    cache.resolve(stroke);
    expect(cache.instrumentation.sampleEncodingBuilds).toBe(builds + 1);
    cache.retire(stroke);
    cache.clear();
    expect(cache.instrumentation.sampleEncodingCacheBytes).toBe(0);
  });

  it("publishes no partial encoding when cancelled and preserves retired reuse", () => {
    const base = createMultiWindowPressureStroke();
    const stroke = {
      ...base,
      points: adoptTransferredStrokeSamples(new Float64Array([...base.points, ...base.points])),
    };
    const cache = new StrokeSampleEncodingCache(() => true);
    const encoding = cache.resolve(stroke);
    cache.retire(stroke);
    const controller = new AbortController();
    const replacement = {
      ...stroke,
      points: adoptTransferredStrokeSamples(new Float64Array(stroke.points)),
    };
    const steps = cache.resolveSteps(replacement, controller.signal);
    expect(steps.next().done).toBe(false);
    controller.abort();
    expect(() => finishGeometrySteps(steps)).toThrow();
    expect(cache.resolve(stroke)).toBe(encoding);
    expect(cache.instrumentation.sampleEncodingBuilds).toBe(1);
  });
});

describe("session-owned sample encodings", () => {
  it("reconciles only changed sample identities and kinds without encoding", () => {
    const stroke = createTestStroke();
    const cache = new StrokeSampleEncodingCache(() => true);
    const encoding = cache.resolve(stroke);
    cache.reconcileElements(
      new Map([[stroke.id, { ...stroke, style: { ...stroke.style, opacity: 0.5 } }]]),
    );
    expect(cache.resolve(stroke)).toBe(encoding);
    expect(cache.instrumentation).toMatchObject({
      sampleEncodingBuilds: 1,
      sampleEncodingHits: 1,
      sampleEncodingCacheElements: 1,
    });
    cache.reconcileElement({ ...stroke, points: [...stroke.points] });
    expect(cache.instrumentation.sampleEncodingCacheElements).toBe(0);
    cache.retainDecoded(stroke.id, stroke.points, encoding);
    cache.reconcileElement({ ...rectangle(), id: stroke.id });
    expect(cache.instrumentation).toMatchObject({
      sampleEncodingBuilds: 1,
      sampleEncodingCacheElements: 0,
      sampleEncodingCacheBytes: 0,
    });
  });

  it("never reuses mutable unowned samples, including same-length mutation", () => {
    const stroke = createTestStroke();
    const cache = new StrokeSampleEncodingCache();
    const first = cache.resolve(stroke);
    stroke.points[0] = 11;
    expect(cache.resolve(stroke)).not.toBe(first);
    expect(cache.instrumentation).toMatchObject({
      sampleEncodingBuilds: 2,
      sampleEncodingHits: 0,
      sampleEncodingCacheElements: 0,
    });
  });

  it("evicts changed identities, deleted strokes, migrated inputs and cleared sessions", () => {
    const stroke = createTestStroke();
    const source = new StrokeSampleEncodingCache();
    const cache = new StrokeSampleEncodingCache(() => true);
    const snapshot = createWorkerSnapshot([stroke]);
    source.retainDecoded(stroke.id, stroke.points, encodeStrokeSamples(stroke.points));
    cache.adoptValidated(source, snapshot, 1);
    expect(cache.resolve(stroke)).toBe(encodeStrokeSamples(stroke.points));
    expect(cache.instrumentation.sampleEncodingHits).toBe(1);
    cache.reconcile(createWorkerSnapshot([{ ...stroke, points: [...stroke.points] }]));
    expect(cache.instrumentation.sampleEncodingCacheElements).toBe(0);
    cache.adoptValidated(source, snapshot, 1);
    cache.reconcile(createWorkerSnapshot([]));
    expect(cache.instrumentation.sampleEncodingCacheElements).toBe(0);
    cache.adoptValidated(source, snapshot, 0);
    expect(cache.instrumentation.sampleEncodingCacheBytes).toBe(0);
    cache.adoptValidated(source, snapshot, 1);
    cache.clear();
    expect(cache.instrumentation).toEqual({
      sampleEncodingBuilds: 0,
      sampleEncodingHits: 0,
      sampleEncodingCacheBytes: 0,
      sampleEncodingCacheElements: 0,
    });
  });

  it("bounds active and retired encoded strings and samples together by count and bytes", () => {
    const cache = new StrokeSampleEncodingCache(() => true);
    const base = createTestStroke();
    const points = adoptTransferredStrokeSamples(new Float64Array(base.points));
    for (let index = 0; index <= 20_000; index += 1) {
      cache.retainDecoded(String(index), points, "AQAAAA==");
      cache.retire({ ...base, id: String(index), points });
    }
    expect(cache.instrumentation.sampleEncodingCacheElements).toBe(20_000);
    cache.retainDecoded("oversized", points, "A".repeat(16 * 1024 * 1024));
    expect(cache.instrumentation.sampleEncodingCacheElements).toBe(20_000);
    cache.retainDecoded("large", points, "A".repeat(15 * 1024 * 1024));
    expect(cache.instrumentation.sampleEncodingCacheBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(cache.instrumentation.sampleEncodingCacheElements).toBeLessThan(20_000);
  });
});

describe("parser sample cache publication", () => {
  const serialized = serializeInkbookDocument(createWorkerSnapshot([createTestStroke()]));
  if (!serialized.ok) throw new Error(serialized.error.code);

  it("injects loaded encodings into the runtime and releases them on disposal", async () => {
    const runtime = new DocumentModelRuntime(true);
    const unlocked = await runtime.unlock(serialized.value.svg);
    expect(runtime.instrumentation.sampleEncodingCacheElements).toBe(1);
    const result = await runtime.export({
      baseModelRevision: null,
      exportGeneration: 1,
      modelRevision: unlocked.snapshot.revision,
      sessionId: "sample-cache",
      snapshot: unlocked.snapshot,
      type: "export-full",
      workerEpoch: 1,
    });
    expect(result).toMatchObject({ ok: true, hash: serialized.value.hash });
    expect(runtime.instrumentation.sampleEncodingBuilds).toBe(0);
    expect(runtime.instrumentation.sampleEncodingHits).toBe(1);
    runtime.clear();
    expect(runtime.instrumentation.sampleEncodingCacheBytes).toBe(0);
  });

  it("publishes only a complete valid document and preserves the previous cache on failure", async () => {
    const cache = new StrokeSampleEncodingCache(() => true);
    const parser = new ChunkedInkbookInputParser({
      staticValidation: "safe",
      sampleEncodingCache: cache,
    });
    expect((await parser.write(new TextEncoder().encode(serialized.value.svg))).ok).toBe(true);
    const result = await parser.finish();
    if (!result.ok) throw new Error(result.error.code);
    expect(parser.retainedSampleEncodingBytes).toBe(0);
    const stroke = result.value.snapshot.elements[0]!;
    if (stroke.kind !== "stroke") throw new Error("Expected stroke.");
    const encoded = cache.resolve(stroke);
    expect(cache.instrumentation.sampleEncodingHits).toBe(1);
    const invalid = new ChunkedInkbookInputParser({
      staticValidation: "safe",
      sampleEncodingCache: cache,
    });
    await invalid.write(new TextEncoder().encode(serialized.value.svg.replace("</svg>", "")));
    expect((await invalid.finish()).ok).toBe(false);
    expect(invalid.retainedSampleEncodingBytes).toBe(0);
    expect(cache.resolve(stroke)).toBe(encoded);
    expect(cache.instrumentation.sampleEncodingBuilds).toBe(0);
  });

  it("discards decoded staging when cancelled before complete static validation", async () => {
    const controller = new AbortController();
    const cache = new StrokeSampleEncodingCache();
    const parser = new ChunkedInkbookInputParser({
      sampleEncodingCache: cache,
      signal: controller.signal,
      staticValidation: "safe",
    });
    const metadataEnd = serialized.value.svg.indexOf("</metadata>") + "</metadata>".length;
    await parser.write(new TextEncoder().encode(serialized.value.svg.slice(0, metadataEnd)));
    expect(parser.retainedSampleEncodingBytes).toBeGreaterThan(0);
    controller.abort();
    await expect(parser.finish()).rejects.toThrow("cancelled");
    expect(parser.retainedSampleEncodingBytes).toBe(0);
    expect(cache.instrumentation.sampleEncodingCacheBytes).toBe(0);
  });
});

it("keeps the current model and encoding ownership when deletion is cancelled", async () => {
  const base = createTestStroke();
  const stroke = { ...base, points: adoptTransferredStrokeSamples(new Float64Array(base.points)) };
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.resetRuntime(createWorkerSnapshot([stroke]), true).ok).toBe(true);
  expect(serializer.serialize().ok).toBe(true);
  const previous = serializer.instrumentation;
  const controller = new AbortController();
  await expect(
    serializer.applyDeltaSliced(
      {
        baseModelRevision: 0,
        modelRevision: 1,
        removedIds: [stroke.id, ...Array.from({ length: 255 }, (_, index) => String(index))],
      },
      {
        signal: controller.signal,
        checkpoint: () => {
          controller.abort();
          return undefined;
        },
      },
      true,
    ),
  ).rejects.toThrow();
  expect(serializer.currentRevision()).toBe(0);
  expect(serializer.currentElementCount()).toBe(1);
  expect(serializer.instrumentation).toEqual(previous);
  serializer.clear();
});
