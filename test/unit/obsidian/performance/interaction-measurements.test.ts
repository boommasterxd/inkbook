import { afterEach, expect, it, vi } from "vitest";
import { runInteractionFrames } from "../../../performance/interaction-refresh-profile";

afterEach(() => vi.restoreAllMocks());

it("runs each input frame in order without reading the wall clock", () => {
  const clock = vi.spyOn(performance, "now").mockImplementation(() => {
    throw new Error("Wall-clock measurement is not part of the scheduling contract.");
  });
  const frames: number[] = [];
  runInteractionFrames((frame) => frames.push(frame), 3);
  expect(frames).toEqual([0, 1, 2]);
  expect(clock).not.toHaveBeenCalled();
});

it.each([-1, 0.5, Number.POSITIVE_INFINITY, 0x1_0000_0000])(
  "rejects invalid frame count %s before running input",
  (count) => {
    const run = vi.fn();
    expect(() => runInteractionFrames(run, count)).toThrow(RangeError);
    expect(run).not.toHaveBeenCalled();
  },
);

it("does not invoke input for an empty trajectory", () => {
  const run = vi.fn();
  runInteractionFrames(run, 0);
  expect(run).not.toHaveBeenCalled();
});

it("propagates operation errors without executing later frames", () => {
  const error = new Error("operation failed");
  const run = vi.fn(() => {
    throw error;
  });
  expect(() => runInteractionFrames(run, 3)).toThrow(error);
  expect(run).toHaveBeenCalledExactlyOnceWith(0);
});
