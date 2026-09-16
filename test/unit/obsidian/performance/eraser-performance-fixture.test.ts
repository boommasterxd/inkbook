import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDenseStrokeEraser,
  MeasuredEraserScheduler,
} from "../../../performance/editor/eraser-performance-fixture";
import { maximumStroke } from "../../../performance/editor/maximum-stroke-fixture";

beforeEach(() => {
  vi.stubEnv("INKBOOK_PERFORMANCE_PROFILE", undefined);
  vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "contracts");
  vi.stubEnv("INKBOOK_PERFORMANCE_REPORT", "1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("eraser checkpoint costs", () => {
  it.each([60, 90, 120, 144, 240])("respects the explicit %i Hz budget", async (hz) => {
    const budget = (1000 / hz) * 0.55;
    const checkpointLimit = Math.ceil(budget / 0.05);
    const wall = vi.spyOn(performance, "now").mockReturnValue(10);
    const scheduler = new MeasuredEraserScheduler(budget);
    wall.mockReturnValue(1000);
    for (let checkpoint = 1; checkpoint < checkpointLimit; checkpoint += 1) {
      expect(scheduler.shouldYield()).toBe(false);
    }
    expect(scheduler.shouldYield()).toBe(true);
    await scheduler.yieldControl();
    expect(scheduler.yieldCount).toBe(1);
    expect(scheduler.sliceDurationsMs).toEqual([990]);
    expect(scheduler.shouldYield()).toBe(false);
    scheduler.finish();
    expect(scheduler.checkpointCounts).toEqual([checkpointLimit, 1]);
    expect(scheduler.maximumSliceMs).toBe(990);
    expect(scheduler.isCancelled()).toBe(false);
  });

  it.each(["reference", "measurement"])(
    "preserves reference wall-clock decisions in %s mode",
    (mode) => {
      vi.stubEnv("INKBOOK_PERFORMANCE_MODE", mode);
      const wall = vi.spyOn(performance, "now").mockReturnValue(10);
      const scheduler = new MeasuredEraserScheduler(2);
      for (let checkpoint = 0; checkpoint < 100; checkpoint += 1) {
        expect(scheduler.shouldYield()).toBe(false);
      }
      wall.mockReturnValue(12);
      expect(scheduler.shouldYield()).toBe(true);
      scheduler.finish();
      expect(scheduler.sliceDurationsMs).toEqual([2]);
    },
  );

  it("preserves actual finalization work in contracts mode", async () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "contracts");
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
      const scheduler = new MeasuredEraserScheduler(0.1);
      let removed = 0;
      await eraser.commit((ids) => {
        removed = ids.size;
        return true;
      }, scheduler);
      scheduler.finish();
      expect(removed).toBe(16);
      expect(scheduler.yieldCount).toBeGreaterThan(0);
      expect(scheduler.checkpointCounts.every((count) => count <= 2)).toBe(true);
      counts.push([...scheduler.checkpointCounts]);
      wall.mockRestore();
    }
    expect(counts[0]).toEqual(counts[1]);
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid cost budget %s", (budget) => {
    expect(() => new MeasuredEraserScheduler(budget)).toThrow("finite and positive");
  });
});
