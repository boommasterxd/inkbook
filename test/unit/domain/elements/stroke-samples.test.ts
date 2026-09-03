import { describe, expect, it } from "vitest";

import { copyStrokeSamplesToRuntime } from "../../../../src/domain/elements/public";

describe("runtime stroke samples", () => {
  it("copies validated wire samples across ownership boundaries", () => {
    const wire = [1, 2, 0.5, 3, 4, 1];
    const runtime = copyStrokeSamplesToRuntime(wire);
    wire[0] = 99;
    expect(Array.from(runtime)).toEqual([1, 2, 0.5, 3, 4, 1]);

    expect(Array.from(runtime)).toEqual([1, 2, 0.5, 3, 4, 1]);
  });

  it.each([
    { samples: [] },
    { samples: [1, 2] },
    { samples: [1.0001, 2, 0.5] },
    { samples: [1, 2, 1.0001] },
    { samples: [1_000_000.001, 2, 0.5] },
    { samples: [Number.POSITIVE_INFINITY, 2, 0.5] },
  ])("rejects invalid wire samples", ({ samples }) => {
    expect(() => copyStrokeSamplesToRuntime(samples)).toThrow(RangeError);
  });
});
