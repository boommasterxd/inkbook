import { expect, it, vi } from "vitest";

import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { createCountedDenseStrokeEraser } from "./eraser-performance-fixture";

it.for([16, 128])(
  "bounds point visits across %i strokes and every finalization yield",
  async (count) => {
    const budget = INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs;
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
