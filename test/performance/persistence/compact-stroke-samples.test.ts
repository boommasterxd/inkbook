import { describe, expect, it, vi } from "vitest";
import {
  decodeStrokeSamplesSteps,
  encodeStrokeSamples,
} from "../../../src/persistence/serialization/stroke-sample-codec";
import { decodeStrokeSamples } from "../../fixtures/persistence/stroke-sample-codec";
import { SampleBase64Reader } from "../../../src/persistence/serialization/sample-base64";

describe("compact stroke sample work bounds", () => {
  it("decodes the maximum stroke with one exact output buffer and one read per encoded byte", () => {
    const points = new Float64Array(16_384 * 3);
    for (let point = 0; point < points.length / 3; point += 1) {
      points[point * 3] = point / 1000;
      points[point * 3 + 1] = point === 0 ? 0 : -point / 1000;
      points[point * 3 + 2] = (point % 11) / 10;
    }
    const encoded = encodeStrokeSamples(points);
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    const encodedBytes = (encoded.length / 4) * 3 - padding;
    const probe = observeDecoderAllocations();

    try {
      const decoded = decodeStrokeSamples(encoded);

      expect(decoded).toEqual(points);
      expect(decoded).toHaveLength(16_384 * 3);
      expect(probe.allocations).toEqual([16_384 * 3]);
      expect(probe.reads).toHaveBeenCalledTimes(encodedBytes);
      expect(encoded.length).toBeLessThanOrEqual(262_148);
    } finally {
      probe.restore();
    }
  });

  it("rejects an oversized point count before allocating the sample buffer", () => {
    const probe = observeDecoderAllocations();

    try {
      expect(() => decodeStrokeSamples("gYAB")).toThrow(RangeError);
      expect(probe.reads).toHaveBeenCalledTimes(3);
      expect(probe.allocations).toEqual([]);
    } finally {
      probe.restore();
    }
  });

  it("bounds additional byte reads after cancellation to one checkpoint interval", () => {
    const points = new Float64Array(1024 * 3);
    const encoded = encodeStrokeSamples(points);
    const reads = vi.spyOn(SampleBase64Reader.prototype, "read");
    const controller = new AbortController();
    const decoder = decodeStrokeSamplesSteps(encoded, controller.signal);

    expect(decoder.next().done).toBe(false);
    const readsAtYield = reads.mock.calls.length;
    expect(readsAtYield).toBeGreaterThan(1);
    controller.abort();
    expect(() => decoder.next()).toThrow();
    expect(reads.mock.calls.length - readsAtYield).toBeLessThanOrEqual(256 * 12);
    reads.mockRestore();
  });
});

describe("compact stroke sample point-budget work bounds", () => {
  it.each([0, 1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects point budget %s before allocating decoded samples",
    (maximumPoints) => {
      const encoded = encodeStrokeSamples(new Float64Array([0, 0, 0, 1, -1, 1]));
      const probe = observeDecoderAllocations();

      try {
        const decoder = decodeStrokeSamplesSteps(encoded, undefined, maximumPoints);
        expect(() => decoder.next()).toThrow(RangeError);
        expect(probe.reads).toHaveBeenCalledTimes(1);
        expect(probe.allocations).toEqual([]);
      } finally {
        probe.restore();
      }
    },
  );
});

function observeDecoderAllocations() {
  const reads = vi.spyOn(SampleBase64Reader.prototype, "read");
  const NativeFloat64Array = Float64Array;
  const allocations: number[] = [];
  vi.stubGlobal(
    "Float64Array",
    new Proxy(NativeFloat64Array, {
      construct(target, argumentsList, newTarget) {
        allocations.push(Number(argumentsList[0]));
        return Reflect.construct(target, argumentsList, newTarget) as InstanceType<typeof target>;
      },
    }),
  );
  return {
    reads,
    allocations,
    restore() {
      reads.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}
