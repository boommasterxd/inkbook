import { describe, expect, it, vi } from "vitest";

import type { InkSnapshotV1 } from "../../../src/domain/schema/public";
import { IncrementalDocumentSerializer } from "../../../src/persistence/serialization/public";
import { createTestStroke, createWorkerSnapshot } from "../../fixtures/persistence/worker-snapshot";
import { createStandardPersistenceFixture } from "./fixtures";
describe("runtime export cache performance", () => {
  it("bounds warm UTF-8 encoding work independently of the 11,000-element fixture", async () => {
    const snapshot = createStandardPersistenceFixture();
    const { serializer, cold } = await warmSerializer(snapshot);
    const warmed = serializer.instrumentation;
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      for (let sample = 0; sample < 2; sample += 1) {
        encode.mockClear();
        const result = await serializer.serializeRuntimeChunked({});
        if (!result.ok) throw new Error(result.error.code);
        expect(result.value.hash).toBe(cold.value.hash);
        expect(result.value.totalBytes).toBe(cold.value.totalBytes);
        // Large metadata and SVG output use bounded encodeInto assembly. Warm encode calls
        // are limited to static document prefixes, never one allocation per cached element.
        expect(encode.mock.calls.length).toBeLessThan(32);
      }
    } finally {
      encode.mockRestore();
      serializer.clear();
    }
    expect(warmed.cacheElements).toBe(11_000);
    expect(warmed.cacheBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(serializer.instrumentation.fragmentBuilds).toBe(warmed.fragmentBuilds);
  }, 120_000);

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
