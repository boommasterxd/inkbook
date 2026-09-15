import { afterEach, expect, it, vi } from "vitest";
import {
  measureInteractionFrames,
  measureInteractionSequence,
} from "../../../performance/interaction-refresh-profile";

afterEach(() => vi.restoreAllMocks());

it("yields after each frame and excludes interleaved work from its actual timing", () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const samples: number[] = [];
  const frames: number[] = [];
  const sequence = measureInteractionSequence(
    (frame) => {
      frames.push(frame);
      clock += frame + 1;
    },
    3,
    samples,
  );

  for (let index = 0; index < 3; index += 1) {
    expect(sequence.next()).toEqual({ done: false, value: undefined });
    expect(frames).toHaveLength(index + 1);
    expect(samples).toHaveLength(index + 1);
    clock += 100;
  }
  const completed = sequence.next();
  expect(completed.done).toBe(true);
  expect(completed.value).toBe(samples);
  expect(samples).toEqual([1, 2, 3]);
});

it("keeps the synchronous measurement path on the same timer boundaries", () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const values = measureInteractionFrames((frame) => {
    clock += frame + 1;
  }, 3);
  expect(values).toEqual([1, 2, 3]);
});

it.each([-1, 0.5, Number.POSITIVE_INFINITY, 0x1_0000_0000])(
  "rejects invalid frame count %s before running input",
  (count) => {
    const run = vi.fn();
    expect(() => measureInteractionFrames(run, count)).toThrow(RangeError);
    expect(run).not.toHaveBeenCalled();
  },
);
