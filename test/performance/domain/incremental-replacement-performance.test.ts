import { describe, expect, it } from "vitest";

import { ElementStore } from "../../../src/domain/store/public";
import { moveSelectionTimeSliced } from "../../../src/editor/selection/transforms";

import { MeasuredSliceScheduler, percentile, requireStroke } from "./domain-scenarios";
import { createStandardDomainFixture } from "./standard-domain-fixture";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";

describe("incremental replacement performance", () => {
  it("prepares in bounded slices and atomically commits only changed records", async ({
    annotate,
  }) => {
    const fixture = createStandardDomainFixture();
    const store = new ElementStore(fixture.elements);
    const commitDurations: number[] = [];
    let maximumPreparationSlice = 0;
    for (let run = 0; run < 6; run += 1) {
      const strokes = fixture.strokeIds.map((id) => requireStroke(store, id));
      const scheduler = new MeasuredSliceScheduler(2);
      const distance = run % 2 === 0 ? 0.001 : -0.001;
      const moved = await moveSelectionTimeSliced(strokes, { x: distance, y: distance }, scheduler);
      if (moved === null) throw new Error("Expected a complete transformed selection.");
      const prepared = await store.prepareElementReplacement(moved, scheduler);
      if (prepared.token === null) throw new Error("Expected a prepared replacement token.");
      scheduler.finish();
      maximumPreparationSlice = Math.max(maximumPreparationSlice, scheduler.maxSliceDuration);
      const started = performance.now();
      expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("committed");
      if (run > 0) commitDurations.push(performance.now() - started);
    }

    const commitP95 = percentile(commitDurations, 0.95);
    await annotate(
      `10k incremental replacement: commit p95=${commitP95.toFixed(3)} ms, ` +
        `maxPreparationSlice=${maximumPreparationSlice.toFixed(3)} ms`,
      "performance",
    );
    expect(commitP95).toBeLessThanOrEqual(timingBudget(16.7));
    expect(maximumPreparationSlice).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      publishedDeltas: 6,
      recordReplacements: 60_000,
      timeSlicedIndexVisits: 60_000,
    });
  }, 30_000);
});
