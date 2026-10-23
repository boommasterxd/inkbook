import { afterEach, describe, expect, it, vi } from "vitest";

import { moveSelectionTimeSliced } from "../../../../src/editor/selection/transform/transforms";
import { createMaximumStroke } from "../../../performance/domain/standard-domain-fixture";

import { CheckpointSliceScheduler } from "../../../performance/domain/domain-scenarios";

let wallMilliseconds = 0;

afterEach(() => vi.restoreAllMocks());

describe("controlled domain slice checkpoints", () => {
  it("counts actual checkpoint polls and resets only at yields", async () => {
    const onYield = vi.fn();
    const scheduler = new CheckpointSliceScheduler(2, onYield);
    expect(scheduler.shouldYield()).toBe(false);
    expect(scheduler.shouldYield()).toBe(true);
    await scheduler.yieldControl();
    expect(onYield).toHaveBeenCalledOnce();
    expect(scheduler.checkpointCounts).toEqual([2]);
    expect(scheduler.shouldYield()).toBe(false);
    scheduler.finish();
    expect(scheduler.checkpointCounts).toEqual([2, 1]);
  });

  it("records explicit yields with no polls and makes finish idempotent", async () => {
    const scheduler = new CheckpointSliceScheduler(1);
    await scheduler.yieldControl();
    scheduler.finish();
    scheduler.finish();
    expect(scheduler.checkpointCounts).toEqual([0, 0]);
    expect(() => scheduler.shouldYield()).toThrow("finished");
    await expect(scheduler.yieldControl()).rejects.toThrow("finished");
  });

  it("rejects reentrant use while a host yield is pending", async () => {
    const scheduler = new CheckpointSliceScheduler(1);
    const pending = scheduler.yieldControl();
    expect(() => scheduler.shouldYield()).toThrow("yielding");
    expect(() => scheduler.finish()).toThrow("yielding");
    await expect(scheduler.yieldControl()).rejects.toThrow("yielding");
    await pending;
    scheduler.finish();
    expect(scheduler.checkpointCounts).toEqual([0, 0]);
  });

  it("propagates yield-hook errors and permits final cleanup", async () => {
    const scheduler = new CheckpointSliceScheduler(1, () => {
      throw new Error("hook failure");
    });
    await expect(scheduler.yieldControl()).rejects.toThrow("hook failure");
    scheduler.finish();
    expect(scheduler.checkpointCounts).toEqual([0, 0]);
  });

  it.each([0, -1, 0.5, NaN, Infinity])("rejects an invalid slice budget %s", (budget) => {
    expect(() => new CheckpointSliceScheduler(budget)).toThrow("positive safe integers");
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
    const scheduler = new CheckpointSliceScheduler(2);
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
