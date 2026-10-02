import { describe, expect, it, vi } from "vitest";
import {
  decodeStrokeSamplesSteps,
  encodeStrokeSamples,
} from "../../../src/persistence/serialization/stroke-sample-codec";
import { decodeStrokeSamples } from "../../fixtures/persistence/stroke-sample-codec";
import { SampleBase64Reader } from "../../../src/persistence/serialization/sample-base64";
import { parseChunkedJsonWithProof } from "../../../src/persistence/serialization/chunked-json-parser";
import { decodeCompactSnapshotSteps } from "../../../src/persistence/serialization/compact-snapshot";
import {
  validateParsedInkSnapshotV1Steps,
  validateRuntimeInkSnapshotV1,
} from "../../../src/domain/schema/snapshot-validation";
import { createOneStrokeWorkerSnapshot } from "../../fixtures/persistence/worker-bridge";
import { finishGeometrySteps } from "../../fixtures/domain/geometry-steps";

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

  it("validates maximum decoded samples once and rescans externally mutable runtime buffers", async () => {
    const count = 16_384;
    const points = new Float64Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      points[index * 3] = index / 1000;
      points[index * 3 + 1] = -index / 1000 || 0;
      points[index * 3 + 2] = (index % 11) / 10;
    }
    const encoded = encodeStrokeSamples(points);
    const source = createOneStrokeWorkerSnapshot();
    const disk = { ...source, elements: [{ ...source.elements[0], points: encoded }] };
    const owned = await parseChunkedJsonWithProof(JSON.stringify(disk), {
      limits: {
        maximumContainerEntries: 20_000,
        maximumDepth: 16,
        maximumNodes: 1024,
        maximumOutputCharacters: encoded.length + 4096,
        maximumStringScratchCharacters: encoded.length,
      },
    });
    const probe = observeDecoderAllocations(true);

    try {
      finishGeometrySteps(
        decodeCompactSnapshotSteps(owned.value, undefined, { proof: owned.proof }),
      );
      const result = finishGeometrySteps(
        validateParsedInkSnapshotV1Steps(owned.value, owned.proof, {}, true),
      );

      expect(result).toMatchObject({ ok: true, statistics: { strokePoints: count } });
      expect(probe.allocations).toEqual([count * 3]);
      expect(probe.sampleReads.pressure).toBe(0);
      // The bounds pass reads endpoint x/y once and interior x/y three times.
      expect(probe.sampleReads.coordinates).toBeLessThanOrEqual(6 * count - 8);
      const previousCoordinateReads = probe.sampleReads.coordinates;
      expect(validateRuntimeInkSnapshotV1(owned.value).ok).toBe(true);
      expect(probe.sampleReads.pressure).toBe(count);
      expect(probe.sampleReads.coordinates - previousCoordinateReads).toBe(8 * count - 8);
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

function observeDecoderAllocations(observeSamples = false) {
  const reads = vi.spyOn(SampleBase64Reader.prototype, "read");
  const NativeFloat64Array = Float64Array;
  const allocations: number[] = [];
  const sampleReads = { coordinates: 0, pressure: 0 };
  vi.stubGlobal(
    "Float64Array",
    new Proxy(NativeFloat64Array, {
      construct(target, argumentsList, newTarget) {
        allocations.push(Number(argumentsList[0]));
        const samples = Reflect.construct(target, argumentsList, newTarget) as InstanceType<
          typeof target
        >;
        return observeSamples
          ? new Proxy(samples, {
              get(buffer, key): unknown {
                if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) {
                  if (Number(key) % 3 === 2) sampleReads.pressure += 1;
                  else sampleReads.coordinates += 1;
                }
                const value: unknown = Reflect.get(buffer, key, buffer);
                return typeof value === "function" ? value.bind(buffer) : value;
              },
            })
          : samples;
      },
    }),
  );
  return {
    reads,
    allocations,
    sampleReads,
    restore() {
      reads.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}
