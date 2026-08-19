import { performance } from "node:perf_hooks";

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { expectReady, NOTE, preparedRecord, probeRecovery } from "./support";

const WARMUP_SAMPLES = 5;
const MEASURED_SAMPLES = 100;
const P95_LIMIT_MS = 75;
const P99_LIMIT_MS = 125;
const MAXIMUM_LIMIT_MS = 250;
const PERCENTILE_BASE = 100;
const MEDIAN_PERCENTILE = 50;
const P95_PERCENTILE = 95;
const P99_PERCENTILE = 99;
const LAST_SAMPLE_OFFSET = -1;

describe("PERF-10K-RECOVERY", () => {
  it("keeps prepare plus durable host transition within desktop gates", async () => {
    const store = expectReady(
      await probeRecovery({
        databaseName: "performance-recovery",
        indexedDb: new IDBFactory(),
      }),
    );
    const samples: number[] = [];
    const totalSamples = WARMUP_SAMPLES + MEASURED_SAMPLES;
    for (let index = 1; index <= totalSamples; index += 1) {
      const attemptId = `performance-${String(index)}`;
      const record = preparedRecord(attemptId, index);
      const started = performance.now();
      const prepared = await store.prepareForward(record);
      const recorded = await store.recordForward({
        acknowledgement: {
          direction: "forward",
          editorViewId: "editor-performance",
          effectId: `effect-${String(index)}`,
          transactionSequence: index,
        },
        attemptId,
        expectedSessionOrder: index,
        note: NOTE,
      });
      const elapsed = performance.now() - started;
      expect(prepared.kind).toBe("written");
      expect(recorded.kind).toBe("written");
      if (index > WARMUP_SAMPLES) samples.push(elapsed);
      await store.deleteAttempt({ attemptId, note: NOTE });
    }

    const ordered = [...samples].sort((left, right) => left - right);
    expect(ordered).toHaveLength(MEASURED_SAMPLES);
    expect(percentile(ordered, P95_PERCENTILE)).toBeLessThanOrEqual(
      P95_LIMIT_MS,
    );
    expect(percentile(ordered, P99_PERCENTILE)).toBeLessThanOrEqual(
      P99_LIMIT_MS,
    );
    expect(ordered.at(LAST_SAMPLE_OFFSET)).toBeLessThanOrEqual(
      MAXIMUM_LIMIT_MS,
    );
    expect(percentile(ordered, MEDIAN_PERCENTILE)).toBeGreaterThanOrEqual(0);
    await store.dispose();
  });
});

function percentile(
  ordered: readonly number[],
  percentileValue: number,
): number {
  const rank = Math.ceil((percentileValue / PERCENTILE_BASE) * ordered.length);
  return ordered[Math.max(0, rank - 1)] ?? Number.POSITIVE_INFINITY;
}
