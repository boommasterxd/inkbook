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
        if (changed !== undefined)
          expect(
            serializer.applyDelta({
              baseModelRevision: snapshot.revision,
              changedElements: [changed],
              modelRevision: snapshot.revision + 1,
            }).ok,
          ).toBe(true);
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
          expect(result.value.snapshot.revision).toBe(snapshot.revision + 1);
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
  const runtime = new DocumentModelRuntime(undefined, true);
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
