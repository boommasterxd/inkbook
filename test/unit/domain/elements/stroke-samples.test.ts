import { describe, expect, it } from "vitest";

import {
  cloneRuntimeStrokeSamples,
  copyRuntimeStrokeSamplesToWire,
  copyStrokeSamplesToRuntime,
  StrokeCaptureBuffer,
} from "../../../../src/domain/elements/public";

describe("runtime stroke samples", () => {
  it("copies validated wire samples across ownership boundaries", () => {
    const wire = [1, 2, 0.5, 3, 4, 1];
    const runtime = copyStrokeSamplesToRuntime(wire);
    wire[0] = 99;
    expect(Array.from(runtime)).toEqual([1, 2, 0.5, 3, 4, 1]);

    const replacement = cloneRuntimeStrokeSamples(runtime);
    expect(replacement).not.toBe(runtime);
    expect(copyRuntimeStrokeSamplesToWire(replacement)).toEqual([1, 2, 0.5, 3, 4, 1]);
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

  it("grows geometrically and publishes one exact canonical copy", () => {
    const capture = new StrokeCaptureBuffer(1);
    capture.append(1.2346, 2.3456, 0.12346);
    capture.append(3, 4, 1);
    expect(capture.sampleCount).toBe(2);
    expect(capture.sampleCapacity).toBe(2);
    expect(Array.from(capture.publish())).toEqual([1.235, 2.346, 0.1235, 3, 4, 1]);
    capture.clear();
    expect(capture.sampleCount).toBe(0);
    expect(() => capture.publish()).toThrow(RangeError);
  });

  it("rejects invalid capture construction and samples", () => {
    expect(() => new StrokeCaptureBuffer(0)).toThrow(RangeError);
    const capture = new StrokeCaptureBuffer();
    expect(() => capture.append(Number.NaN, 0, 0.5)).toThrow(RangeError);
    expect(() => capture.append(0, 0, -0.1)).toThrow(RangeError);
    expect(() => capture.append(1_000_001, 0, 0.5)).toThrow(RangeError);
  });
});
