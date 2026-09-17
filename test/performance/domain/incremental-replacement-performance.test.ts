import { describe, expect, it } from "vitest";

import { ElementStore } from "../../../src/domain/store/public";
import { moveSelectionTimeSliced } from "../../../src/editor/selection/transforms";

import { percentile } from "./action-distribution";
import { MeasuredSliceScheduler, requireStroke } from "./domain-scenarios";
import { createStandardDomainFixture } from "./standard-domain-fixture";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { expectTiming, recordRelativeTiming } from "../timing-assertions";

describe("incremental replacement performance", () => {
  it("prepares in bounded slices and atomically commits only changed records", async ({
    annotate,
  }) => {
    const fixture = createStandardDomainFixture();
    const store = new ElementStore(fixture.elements);
    const commitDurations = new Array<number>(5);
    const sliceDurations: number[] = [];
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
      sliceDurations.push(...scheduler.sliceDurations);
      maximumPreparationSlice = Math.max(maximumPreparationSlice, scheduler.maxSliceDuration);
      const started = performance.now();
      const result = store.commitPreparedElementReplacement(prepared.token);
      const duration = performance.now() - started;
      expect(result.status).toBe("committed");
      if (run > 0) commitDurations[run - 1] = duration;
    }

    const commitP95 = percentile(commitDurations, 0.95);
    await annotate(
      `10k incremental replacement: commit p95=${commitP95.toFixed(3)} ms, ` +
        `maxPreparationSlice=${maximumPreparationSlice.toFixed(3)} ms`,
      "performance",
    );
    expectTiming(commitP95, INTERACTION_REFRESH_PROFILE.atomicCommitMaxMs);
    expect(sliceDurations.length).toBeGreaterThanOrEqual(100);
    expectTiming(percentile(sliceDurations, 0.95), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expectTiming(maximumPreparationSlice, INTERACTION_REFRESH_PROFILE.atomicCommitMaxMs);
    recordRelativeTiming(
      sliceDurations.reduce((total, duration) => total + duration, 0),
      "total preparation CPU time across six replacements",
    );
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      publishedDeltas: 6,
      recordReplacements: 60_000,
      timeSlicedIndexVisits: 60_000,
    });
  }, 30_000);
});
