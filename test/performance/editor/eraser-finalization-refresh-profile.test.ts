import { describe, expect, it } from "vitest";

import { percentile } from "../domain/domain-scenarios";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";
import { createDenseStrokeEraser, MeasuredEraserScheduler } from "./eraser-performance-fixture";
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
    expect(percentile(sliceDurationsMs, 0.95)).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    expect(maximumSliceMs).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.atomicCommitMaxMs),
    );
  }, 10_000);
});
