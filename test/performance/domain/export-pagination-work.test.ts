import { describe, expect, it } from "vitest";
import {
  chooseExportCut,
  prepareExportCutsSteps,
  type ExportInterval,
} from "../../../src/domain/export/export-pagination";
import { consumeSerializationSteps } from "../../../src/persistence/serialization/output/serialization-model-preparation";
import { createTestWorkScheduler } from "../../fixtures/persistence/work-scheduler";

function observedIntervals(fixed: readonly ExportInterval[]) {
  let reads = 0;
  const intervals = Array.from({ length: 10_000 }, (_, index) => ({
    get minY() {
      reads += 1;
      return fixed[index]?.minY ?? 5_000 + index * 10;
    },
    get maxY() {
      reads += 1;
      return fixed[index]?.maxY ?? 5_005 + index * 10;
    },
  }));
  return {
    intervals,
    get reads() {
      return reads;
    },
  };
}

it("queries one earlier clear export cut logarithmically without rereading 10,000 intervals", async () => {
  const observed = observedIntervals([
    { minY: 298, maxY: 502 },
    { minY: 900, maxY: 2_000 },
    { minY: 1_060, maxY: 1_110 },
    { minY: 1_080, maxY: 1_130 },
  ]);
  const prepared = await consumeSerializationSteps(prepareExportCutsSteps(observed.intervals), {});
  expect(observed.reads).toBe(20_000);
  expect(prepared.instrumentation.eventCount).toBe(20_000);
  // Each of the regular and fallback queries uses two binary searches and one range minimum.
  const maximumVisits = 8 * Math.ceil(Math.log2(20_001)) + 8;
  for (const { options, expected } of [
    {
      options: { start: 0, limit: 474.872, minimum: 100, lookback: 142, clearance: 3 },
      expected: 295,
    },
    {
      options: { start: 1_000, limit: 1_100, minimum: 20, lookback: 30 },
      expected: 1_080,
    },
  ]) {
    const before = prepared.instrumentation.queryVisits;
    expect(chooseExportCut(prepared, options)).toBe(expected);
    expect(prepared.instrumentation.queryVisits - before).toBeLessThanOrEqual(maximumVisits);
    expect(observed.reads).toBe(20_000);
  }
});

it("compares clearance-adjusted candidates logarithmically at 10,000 intervals", async () => {
  const observed = observedIntervals([
    ...Array.from({ length: 4 }, () => ({ minY: 100, maxY: 120 })),
    { minY: 100, maxY: 200 },
    { minY: 140, maxY: 200 },
  ]);
  const prepared = await consumeSerializationSteps(prepareExportCutsSteps(observed.intervals), {});
  expect(observed.reads).toBe(20_000);
  const maximumVisits = 4 * Math.ceil(Math.log2(prepared.instrumentation.eventCount + 1)) + 4;
  for (const { limit, expected } of [
    { limit: 130, expected: 130 },
    { limit: 150, expected: 139 },
  ]) {
    const before = prepared.instrumentation.queryVisits;
    expect(
      chooseExportCut(prepared, {
        start: 0,
        minimum: 100,
        limit,
        lookback: limit - 100,
        clearance: 1,
      }),
    ).toBe(expected);
    expect(prepared.instrumentation.queryVisits - before).toBeLessThanOrEqual(maximumVisits);
    expect(observed.reads).toBe(20_000);
  }
});

describe("export pagination work", () => {
  it("reads 10,000 element intervals once and reuses a logarithmic numeric query index", async () => {
    let reads = 0;
    const intervals = Array.from({ length: 10_000 }, (_, index) => ({
      get minY() {
        reads += 1;
        return index * 10;
      },
      get maxY() {
        reads += 1;
        return index * 10 + 5;
      },
    }));
    let checkpoints = 0;
    let previousReads = 0;
    const scheduler = createTestWorkScheduler({
      checkpoint: () => {
        checkpoints += 1;
        // At most 256 immutable numeric intervals are consumed before cancellation is checked.
        expect(reads - previousReads).toBeLessThanOrEqual(512);
        previousReads = reads;
      },
    });
    const prepared = await consumeSerializationSteps(prepareExportCutsSteps(intervals), {
      checkpoint: () => scheduler.checkpoint(),
    });
    expect(reads).toBe(20_000);
    expect(prepared.instrumentation.eventCount).toBe(20_000);
    // Actual scheduler probes cover validation, 15 merge passes, event sweep and both tree bands.
    const chunks = (count: number) => Math.ceil(count / 256);
    expect(checkpoints).toBeLessThanOrEqual(
      chunks(10_000) + 15 * chunks(20_000) + chunks(20_000) + chunks(32_768) + chunks(32_767),
    );
    // Two binary searches and a segment-tree range query each visit at most logarithmic nodes.
    const visitsPerCut = 4 * Math.ceil(Math.log2(20_001)) + 4;
    for (let page = 0; page < 100; page += 1) {
      const before = prepared.instrumentation.queryVisits;
      const limit = (page + 1) * 900 + 2;
      expect(
        chooseExportCut(prepared, {
          start: page * 900,
          limit,
          minimum: 100,
          lookback: 500,
        }),
      ).toBe(limit - 2);
      expect(prepared.instrumentation.queryVisits - before).toBeLessThanOrEqual(visitsPerCut);
    }
    expect(reads).toBe(20_000);
  });

  it("cancels while sorting without publishing a partial index or retaining input ownership", async () => {
    let reads = 0;
    const intervals = Array.from({ length: 10_000 }, (_, index) => ({
      get minY() {
        reads += 1;
        return 100_000 - index * 10;
      },
      get maxY() {
        reads += 1;
        return 100_005 - index * 10;
      },
    }));
    const abort = new AbortController();
    let checkpointsAfterRead = 0;
    const scheduler = createTestWorkScheduler({
      checkpoint: () => {
        if (reads === 20_000 && ++checkpointsAfterRead === 2) abort.abort();
      },
    });
    await expect(
      consumeSerializationSteps(prepareExportCutsSteps(intervals), {
        signal: abort.signal,
        checkpoint: () => scheduler.checkpoint(abort.signal),
      }),
    ).rejects.toThrow();
    expect(reads).toBe(20_000);
    const prepared = await consumeSerializationSteps(prepareExportCutsSteps(intervals), {});
    expect(prepared.instrumentation.eventCount).toBe(20_000);
    expect(chooseExportCut(prepared, { start: 0, limit: 902, minimum: 100, lookback: 500 })).toBe(
      900,
    );
    expect(reads).toBe(40_000);
  });
});
