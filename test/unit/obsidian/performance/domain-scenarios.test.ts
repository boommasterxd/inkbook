import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { moveSelectionTimeSliced } from "../../../../src/editor/selection/transforms";
import { createMaximumStroke } from "../../../performance/domain/standard-domain-fixture";

import {
  CHECKPOINT_COST_MILLISECONDS,
  MeasuredSliceScheduler,
} from "../../../performance/domain/domain-scenarios";

declare const process: {
  threadCpuUsage: () => { system: number; user: number };
};

let wallMilliseconds = 0;
let cpuMicroseconds = 0;

beforeEach(() => {
  wallMilliseconds = 0;
  cpuMicroseconds = 0;
  vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "contracts");
  vi.stubEnv("INKBOOK_PERFORMANCE_PROFILE", undefined);
  vi.stubEnv("INKBOOK_PERFORMANCE_REPORT", "1");
  vi.spyOn(performance, "now").mockImplementation(() => wallMilliseconds);
  vi.spyOn(process, "threadCpuUsage").mockImplementation(() => ({
    system: 0,
    user: cpuMicroseconds,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("controlled domain slice checkpoints", () => {
  it("counts actual checkpoint polls in contracts mode", async () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "contracts");
    const onYield = vi.fn(() => {
      cpuMicroseconds += 50_000;
    });
    const scheduler = new MeasuredSliceScheduler(2 * CHECKPOINT_COST_MILLISECONDS, onYield);
    wallMilliseconds = 1_000_000;
    expect(scheduler.shouldYield()).toBe(false);
    expect(scheduler.shouldYield()).toBe(true);
    cpuMicroseconds = 1_250;
    await scheduler.yieldControl();
    expect(onYield).toHaveBeenCalledOnce();
    expect(scheduler.checkpointCounts).toEqual([2]);
    expect(scheduler.sliceDurations).toEqual([1.25]);
    expect(scheduler.shouldYield()).toBe(false);
    cpuMicroseconds += 500;
    scheduler.finish();
    expect(scheduler.checkpointCounts).toEqual([2, 1]);
    expect(scheduler.sliceDurations).toEqual([1.25, 0.5]);
    expect(scheduler.maxSliceDuration).toBe(1.25);
  });

  it.each([60, 90, 120, 144, 240])(
    "uses the explicit %i Hz budget without reading wall time",
    (hz) => {
      const budget = (1000 / hz) * 0.55;
      const scheduler = new MeasuredSliceScheduler(budget);
      const checkpointLimit = Math.ceil(budget / CHECKPOINT_COST_MILLISECONDS);
      for (let checkpoint = 1; checkpoint < checkpointLimit; checkpoint += 1) {
        expect(scheduler.shouldYield()).toBe(false);
      }
      expect(scheduler.shouldYield()).toBe(true);
      scheduler.finish();
      expect(scheduler.checkpointCounts).toEqual([checkpointLimit]);
    },
  );

  it("keeps reference deadline decisions separate from actual CPU measurements", async () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "reference");
    const scheduler = new MeasuredSliceScheduler(2);
    for (let checkpoint = 0; checkpoint < 200; checkpoint += 1) {
      expect(scheduler.shouldYield()).toBe(false);
    }
    wallMilliseconds = 2;
    cpuMicroseconds = 300;
    expect(scheduler.shouldYield()).toBe(true);
    await scheduler.yieldControl();
    expect(scheduler.sliceDurations).toEqual([0.3]);
    wallMilliseconds = 3.999;
    expect(scheduler.shouldYield()).toBe(false);
    wallMilliseconds = 4;
    expect(scheduler.shouldYield()).toBe(true);
    scheduler.finish();
    expect(scheduler.checkpointCounts).toEqual([201, 2]);
  });

  it("records explicit yields with no polls and makes finish idempotent", async () => {
    const scheduler = new MeasuredSliceScheduler(1);
    await scheduler.yieldControl();
    scheduler.finish();
    scheduler.finish();
    expect(scheduler.checkpointCounts).toEqual([0, 0]);
    expect(scheduler.sliceDurations).toHaveLength(2);
    expect(() => scheduler.shouldYield()).toThrow("finished");
    await expect(scheduler.yieldControl()).rejects.toThrow("finished");
  });

  it("rejects reentrant use while a host yield is pending", async () => {
    const scheduler = new MeasuredSliceScheduler(1);
    const pending = scheduler.yieldControl();
    expect(() => scheduler.shouldYield()).toThrow("yielding");
    expect(() => scheduler.finish()).toThrow("yielding");
    await expect(scheduler.yieldControl()).rejects.toThrow("yielding");
    await pending;
    scheduler.finish();
    expect(scheduler.checkpointCounts).toEqual([0, 0]);
  });

  it("propagates yield-hook errors and permits final cleanup", async () => {
    const scheduler = new MeasuredSliceScheduler(1, () => {
      throw new Error("hook failure");
    });
    await expect(scheduler.yieldControl()).rejects.toThrow("hook failure");
    scheduler.finish();
    expect(scheduler.checkpointCounts).toEqual([0, 0]);
  });

  it.each([0, -1, NaN, Infinity])("rejects an invalid slice budget %s", (budget) => {
    expect(() => new MeasuredSliceScheduler(budget)).toThrow("finite and positive");
  });
});

it("preserves real transform work across different wall-clock speeds", async () => {
  const elements = Array.from({ length: 5 }, () => createMaximumStroke());
  const observations: number[][] = [];
  for (const clockStep of [0, 1_000_000]) {
    vi.spyOn(performance, "now").mockImplementation(() => {
      wallMilliseconds += clockStep;
      return wallMilliseconds;
    });
    const scheduler = new MeasuredSliceScheduler(2 * CHECKPOINT_COST_MILLISECONDS);
    const transformed = await moveSelectionTimeSliced(elements, { x: 10, y: 20 }, scheduler);
    scheduler.finish();
    expect(transformed).toHaveLength(5);
    expect(transformed?.[0]?.pivot).toEqual({
      x: elements[0]!.pivot.x + 10,
      y: elements[0]!.pivot.y + 20,
    });
    observations.push([...scheduler.checkpointCounts]);
  }
  expect(observations).toEqual([
    [2, 2, 1],
    [2, 2, 1],
  ]);
});
