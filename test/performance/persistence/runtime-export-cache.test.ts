import { describe, expect, it, vi } from "vitest";

import type { InkSnapshotV1 } from "../../../src/domain/schema/public";
import { IncrementalDocumentSerializer } from "../../../src/persistence/serialization/public";
import { createTestStroke, createWorkerSnapshot } from "../../fixtures/persistence/worker-snapshot";
import { createStandardPersistenceFixture } from "./fixtures";
import {
  annotateDurations,
  collectProfileGarbage,
  expectProfileRunsBudget,
  measureAsync,
} from "./metrics";

describe("runtime export cache performance", () => {
  it("bounds warm UTF-8 encoding work independently of the 11,000-element fixture", async ({
    annotate,
  }) => {
    const snapshot = createStandardPersistenceFixture();
    const { serializer, cold } = await warmSerializer(snapshot);
    const warmed = serializer.instrumentation;
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const durations: number[] = [];
    try {
      for (let sample = 0; sample < 5; sample += 1) {
        collectProfileGarbage();
        encode.mockClear();
        const measured = await measureAsync(() => serializer.serializeRuntimeChunked({}));
        durations.push(measured.durationMs);
        if (!measured.value.ok) throw new Error(measured.value.error.code);
        expect(measured.value.value.hash).toBe(cold.value.hash);
        expect(measured.value.value.totalBytes).toBe(cold.value.totalBytes);
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
    await annotateDurations(annotate, "warm cached standard runtime export", durations);
    expectProfileRunsBudget([durations], 100);
  }, 120_000);

  for (const type of ["lines", "squares", "dots"] as const) {
    it(`builds a 20,000-unit ${type} background once across repeated runtime exports`, async ({
      annotate,
    }) => {
      const stroke = createTestStroke();
      const snapshot = createWorkerSnapshot([
        { ...stroke, pivot: { x: 15, y: 20_000 }, points: [10, 19_990, 0.5, 20, 20_000, 1] },
      ]);
      snapshot.page.background = { type, spacing: 25 };
      const { serializer, cold } = await warmSerializer(snapshot);
      const durations: number[] = [];
      for (let sample = 0; sample < 20; sample += 1) {
        const measured = await measureAsync(() => serializer.serializeRuntimeChunked({}));
        durations.push(measured.durationMs);
        if (!measured.value.ok) throw new Error(measured.value.error.code);
        expect(measured.value.value.hash).toBe(cold.value.hash);
      }
      expect(serializer.instrumentation.backgroundBuilds).toBe(1);
      expect(serializer.instrumentation.fragmentBuilds).toBe(1);
      serializer.clear();
      await annotateDurations(annotate, `warm cached ${type} background export`, durations);
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
