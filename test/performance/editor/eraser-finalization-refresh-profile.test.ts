import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
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
      fixture.eraser.update({ x: MAX_STROKE_POINTS + 1_000, y: 0 });
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
      // One pass over every segment plus two initial x coordinates per stroke.
      expect(totalPointReads).toBeLessThanOrEqual(count * (MAX_STROKE_POINTS + 1));
      expect(totalPointReads).toBeGreaterThanOrEqual(count * (MAX_STROKE_POINTS - 1));
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

it("drains multiple feedback quanta without a frame wait while the shared budget remains", async () => {
  const fixture = createCountedDenseStrokeEraser(16);
  const yieldControl = vi.fn(async () => undefined);
  const remove = vi.fn((ids: ReadonlySet<string>) => {
    expect(ids.size).toBe(16);
    return true;
  });
  let checkpoints = 0;
  let totalPointReads = fixture.takePointReads();
  fixture.eraser.update({ x: MAX_STROKE_POINTS + 1_000, y: 0 });
  totalPointReads += fixture.takePointReads();

  const committed = await fixture.eraser.commit(remove, {
    isCancelled: () => false,
    shouldYield: () => {
      const reads = fixture.takePointReads();
      totalPointReads += reads;
      expect(reads).toBeLessThanOrEqual(256 + 2);
      checkpoints += 1;
      return false;
    },
    yieldControl,
  });

  expect(committed).toBe(true);
  expect(remove).toHaveBeenCalledOnce();
  expect(checkpoints).toBeGreaterThan(12_288 / 256);
  expect(totalPointReads + fixture.takePointReads()).toBeGreaterThan(12_288);
  expect(yieldControl).not.toHaveBeenCalled();
  expect(fixture.eraser.retainedSweepCount).toBe(0);
});

it("cancels finalization at the next yield without reading or publishing more work", async () => {
  const fixture = createCountedDenseStrokeEraser(128);
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  let cancelled = false;
  let removals = 0;
  let yields = 0;
  try {
    fixture.eraser.update({ x: MAX_STROKE_POINTS + 1_000, y: 0 });
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
