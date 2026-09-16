import { afterEach, expect, it, vi } from "vitest";
import { measureInteractionFrames } from "../../../performance/interaction-refresh-profile";

afterEach(() => vi.restoreAllMocks());

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

it("does not invoke input for an empty trajectory", () => {
  const run = vi.fn();
  expect(measureInteractionFrames(run, 0)).toEqual([]);
  expect(run).not.toHaveBeenCalled();
});

it("propagates operation errors without executing later frames", () => {
  const error = new Error("operation failed");
  const run = vi.fn(() => {
    throw error;
  });
  expect(() => measureInteractionFrames(run, 3)).toThrow(error);
  expect(run).toHaveBeenCalledExactlyOnceWith(0);
});
