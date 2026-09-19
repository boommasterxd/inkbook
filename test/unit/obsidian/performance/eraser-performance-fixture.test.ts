import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckpointSliceScheduler } from "../../../performance/domain/domain-scenarios";
import { createDenseStrokeEraser } from "../../../performance/editor/eraser-performance-fixture";
import { maximumStroke } from "../../../performance/editor/maximum-stroke-fixture";
afterEach(() => vi.restoreAllMocks());
describe("eraser deterministic finalization", () => {
  it("preserves finalization work independently of wall-clock speed", async () => {
    const counts: number[][] = [];
    for (const wallStep of [0, 100_000]) {
      let wallTime = 0;
      const wall = vi.spyOn(performance, "now").mockImplementation(() => ++wallTime);
      const strokes = Array.from({ length: 16 }, (_, index) => maximumStroke(index));
      const eraser = createDenseStrokeEraser(strokes, () => 0.000001);
      eraser.update({ x: 5000, y: 0 });
      expect(eraser.retainedSweepCount).toBeGreaterThan(0);
      expect(eraser.candidateCount).toBeLessThan(strokes.length);
      wall.mockImplementation(() => {
        wallTime += wallStep;
        return wallTime;
      });
      const scheduler = new CheckpointSliceScheduler(2);
      let removed = 0;
      await eraser.commit(
        (ids) => {
          removed = ids.size;
          return true;
        },
        {
          shouldYield: scheduler.shouldYield,
          yieldControl: scheduler.yieldControl,
          isCancelled: () => false,
        },
      );
      scheduler.finish();
      expect(removed).toBe(16);
      expect(scheduler.checkpointCounts.length).toBeGreaterThan(1);
      expect(scheduler.checkpointCounts.every((count) => count <= 2)).toBe(true);
      counts.push([...scheduler.checkpointCounts]);
      wall.mockRestore();
    }
    expect(counts[0]).toEqual(counts[1]);
  });
});
