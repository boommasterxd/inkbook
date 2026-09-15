import { describe, expect, it, vi } from "vitest";

import { percentile } from "../domain/domain-scenarios";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";
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
      expect(removed).toBe(strokes.length);
      expect(scheduler.yieldCount).toBeGreaterThan(0);
      sliceDurationsMs.push(...scheduler.sliceDurationsMs);
      maximumSliceMs = Math.max(maximumSliceMs, scheduler.maximumSliceMs);
    }

    expect(sliceDurationsMs.length).toBeGreaterThanOrEqual(100);
    expectTiming(percentile(sliceDurationsMs, 0.95), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expectTiming(maximumSliceMs, INTERACTION_REFRESH_PROFILE.atomicCommitMaxMs);
  }, 10_000);
});

it("bounds point visits before every finalization yield at the selected cadence", async () => {
  const budget = INTERACTION_REFRESH_PROFILE.mainThreadP99Ms;
  const fixture = createCountedDenseStrokeEraser(16, () => budget);
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  // Current finalization allowance: 16 segment checks/ms after a 0.25 ms reserve, capped at 256.
  const workPerCheckpoint = Math.max(1, Math.min(256, Math.floor((budget - 0.25) * 16)));
  let checkpoints = 0;
  let yields = 0;
  try {
    fixture.eraser.update({ x: 5_000, y: 0 });
    fixture.takePointReads();
    const committed = await fixture.eraser.commit(
      (ids) => {
        expect(ids.size).toBe(16);
        return true;
      },
      {
        isCancelled: () => false,
        shouldYield: () => {
          expect(fixture.takePointReads()).toBeLessThanOrEqual(workPerCheckpoint + 2);
          checkpoints += 1;
          return true;
        },
        yieldControl: async () => {
          yields += 1;
        },
      },
    );
    expect(committed).toBe(true);
    expect(fixture.takePointReads()).toBeLessThanOrEqual(workPerCheckpoint + 2);
    expect(checkpoints).toBeGreaterThan(0);
    expect(yields).toBe(checkpoints);
    expect(fixture.eraser.retainedSweepCount).toBe(0);
    expect(fixture.eraser.retainedCandidateIdCount).toBe(0);
  } finally {
    fixture.eraser.revert();
    clock.mockRestore();
  }
});
