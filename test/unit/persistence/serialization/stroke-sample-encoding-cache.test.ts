import { describe, expect, it } from "vitest";
import { StrokeSampleEncodingCache } from "../../../../src/persistence/serialization/stroke-sample-encoding-cache";
import { encodeStrokeSamples } from "../../../../src/persistence/serialization/stroke-sample-codec";
import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/chunked-input-codec";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { DocumentModelRuntime } from "../../../../src/persistence/worker/runtime/document-model";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";

describe("session-owned sample encodings", () => {
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

  it("bounds retained encoded strings and sample ownership by count and bytes", () => {
    const cache = new StrokeSampleEncodingCache();
    const points = createTestStroke().points;
    for (let index = 0; index <= 20_000; index += 1) {
      cache.retainDecoded(String(index), points, "AQAAAA==");
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
