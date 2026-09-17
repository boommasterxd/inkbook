import { describe, expect, it, vi } from "vitest";

import { percentile } from "../domain/domain-scenarios";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { expectTiming, recordRelativeTiming } from "../timing-assertions";
import {
  createCountedDenseStrokeEraser,
  createDenseStrokeEraser,
  MeasuredEraserScheduler,
} from "./eraser-performance-fixture";
import { maximumStroke } from "./maximum-stroke-fixture";

const FINALIZATION_RUNS = 50;

describe("eraser finalization performance", () => {
  it("keeps exact finalization slices within the selected main-thread budget", async () => {
    const strokes = Array.from({ length: 128 }, (_, index) => maximumStroke(index));
    const sliceDurationsMs: number[] = [];
    let maximumSliceMs = 0;
    let maximumRunElapsedMs = 0;
    let invalidRuns = 0;
    for (let run = 0; run < FINALIZATION_RUNS; run += 1) {
      const eraser = createDenseStrokeEraser(
        strokes,
        () => INTERACTION_REFRESH_PROFILE.mainThreadP99Ms,
      );
      eraser.update({ x: 5_000, y: 0 });
      const scheduler = new MeasuredEraserScheduler(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
      let removed = 0;
      await eraser.commit((ids) => {
        removed = ids.size;
        return true;
      }, scheduler);
      scheduler.finish();
      if (removed !== strokes.length || scheduler.yieldCount <= 0) invalidRuns += 1;
      sliceDurationsMs.push(...scheduler.sliceDurationsMs);
      maximumSliceMs = Math.max(maximumSliceMs, scheduler.maximumSliceMs);
      maximumRunElapsedMs = Math.max(
        maximumRunElapsedMs,
        scheduler.sliceDurationsMs.reduce((total, duration) => total + duration, 0),
      );
    }

    expect(invalidRuns).toBe(0);
    expect(sliceDurationsMs.length).toBeGreaterThanOrEqual(100);
    expectTiming(percentile(sliceDurationsMs, 0.95), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expectTiming(maximumSliceMs, INTERACTION_REFRESH_PROFILE.atomicCommitMaxMs);
    recordRelativeTiming(
      maximumRunElapsedMs,
      "maximum complete eraser finalization active-slice elapsed time across 50 runs",
    );
  }, 10_000);
});

it.for([16, 128])(
  "bounds point visits across %i strokes and every finalization yield",
  async (count) => {
    const budget = INTERACTION_REFRESH_PROFILE.mainThreadP99Ms;
    const fixture = createCountedDenseStrokeEraser(count, () => budget);
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    // Current finalization allowance: 16 segment checks/ms after a 0.25 ms reserve, capped at 256.
    const workPerCheckpoint = Math.max(1, Math.min(256, Math.floor((budget - 0.25) * 16)));
    let checkpoints = 0;
    let yields = 0;
    try {
      fixture.eraser.update({ x: 5_000, y: 0 });
      let totalPointReads = fixture.takePointReads();
      const committed = await fixture.eraser.commit(
        (ids) => {
          expect(ids.size).toBe(count);
          return true;
        },
        {
          isCancelled: () => false,
          shouldYield: () => {
            const reads = fixture.takePointReads();
            totalPointReads += reads;
            expect(reads).toBeLessThanOrEqual(workPerCheckpoint + 2);
            checkpoints += 1;
            return true;
          },
          yieldControl: async () => {
            yields += 1;
          },
        },
      );
      expect(committed).toBe(true);
      const finalReads = fixture.takePointReads();
      totalPointReads += finalReads;
      expect(finalReads).toBeLessThanOrEqual(workPerCheckpoint + 2);
      // One pass over 4,095 segments plus two initial x coordinates per stroke.
      expect(totalPointReads).toBeLessThanOrEqual(count * 4_097);
      expect(totalPointReads).toBeGreaterThanOrEqual(count * 4_095);
      expect(checkpoints).toBeGreaterThan(0);
      expect(yields).toBe(checkpoints);
      expect(fixture.eraser.retainedSweepCount).toBe(0);
      expect(fixture.eraser.retainedCandidateIdCount).toBe(0);
    } finally {
      fixture.eraser.revert();
      clock.mockRestore();
    }
  },
);

it("cancels finalization at the next yield without reading or publishing more work", async () => {
  const fixture = createCountedDenseStrokeEraser(128);
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  let cancelled = false;
  let removals = 0;
  let yields = 0;
  try {
    fixture.eraser.update({ x: 5_000, y: 0 });
    const committed = await fixture.eraser.commit(
      () => {
        removals += 1;
        return true;
      },
      {
        isCancelled: () => cancelled,
        shouldYield: () => true,
        yieldControl: async () => {
          yields += 1;
          fixture.takePointReads();
          cancelled = true;
        },
      },
    );
    expect(committed).toBe(false);
    expect(yields).toBe(1);
    expect(removals).toBe(0);
    expect(fixture.takePointReads()).toBe(0);
    expect(fixture.eraser.candidateCount).toBe(0);
    expect(fixture.eraser.retainedSweepCount).toBe(0);
    expect(fixture.eraser.retainedCandidateIdCount).toBe(0);
  } finally {
    fixture.eraser.revert();
    clock.mockRestore();
  }
});
