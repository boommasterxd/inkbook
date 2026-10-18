import { describe, expect, it, vi } from "vitest";
import {
  decodeStrokeSamplesSteps,
  encodeStrokeSampleBytesSteps,
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

describe("compact stroke sample encoding work bounds", () => {
  it("emits maximum-stroke ASCII bytes without native text conversion or oversized output", () => {
    const points = maximumEncodingSamples();
    const { allocations, decode, encode, restore } = observeEncodingBuffers();
    try {
      const encoded = finishGeometrySteps(encodeStrokeSampleBytesSteps(points));
      expect(encoded.byteLength).toBe(262_148);
      expect(encoded.buffer.byteLength).toBe(encoded.byteLength);
      expect(allocations[0]).toBe(256);
      expect(allocations[allocations.length - 1]).toBe(encoded.byteLength);
      expect(allocations.slice(1, -1).every((bytes) => bytes > 0 && bytes <= 256)).toBe(true);
      expect(allocations.length).toBe(Math.ceil(encoded.byteLength / 256) + 2);
      expect(allocations.reduce((sum, bytes) => sum + bytes, 0)).toBe(encoded.byteLength * 2 + 256);
      expect(decode).not.toHaveBeenCalled();
      expect(encode).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("encodes a maximum stroke through one bounded ASCII buffer and one decode per chunk", () => {
    const points = maximumEncodingSamples();
    const { allocations, decode, restore } = observeEncodingBuffers();
    try {
      const encoded = encodeStrokeSamples(points);
      const inputs = decode.mock.calls.map(([input]) => input as Uint8Array);
      expect(allocations).toEqual([256]);
      expect(encoded.length).toBe(262_148);
      expect(inputs).toHaveLength(Math.ceil(encoded.length / 256));
      expect(inputs.reduce((sum, input) => sum + input.byteLength, 0)).toBe(encoded.length);
      expect(inputs.every((input) => input.byteLength > 0 && input.byteLength <= 256)).toBe(true);
      expect(new Set(inputs.map((input) => input.buffer)).size).toBe(1);
      expect(decodeStrokeSamples(encoded)).toEqual(points);
    } finally {
      restore();
    }
  });
});

function maximumEncodingSamples(): Float64Array<ArrayBuffer> {
  const points = new Float64Array(16_384 * 3);
  for (let point = 0; point < points.length / 3; point += 1) {
    points[point * 3] = point % 2 === 0 ? 1_000_000 : -1_000_000;
    points[point * 3 + 1] = -points[point * 3]!;
    points[point * 3 + 2] = 1;
  }
  return points;
}

function observeEncodingBuffers() {
  const NativeUint8Array = Uint8Array;
  const allocations: number[] = [];
  vi.stubGlobal(
    "Uint8Array",
    new Proxy(NativeUint8Array, {
      construct(target, argumentsList, newTarget) {
        allocations.push(Number(argumentsList[0]));
        return Reflect.construct(target, argumentsList, newTarget) as InstanceType<typeof target>;
      },
    }),
  );
  const decode = vi.spyOn(TextDecoder.prototype, "decode");
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  return {
    allocations,
    decode,
    encode,
    restore(this: void) {
      decode.mockRestore();
      encode.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

describe("compact sample byte assembly checkpoints", () => {
  it.each([false, true])("copies at most 64 KiB between checkpoints (abort=%s)", (abort) => {
    const nativeSet = Reflect.get<Uint8Array, "set">(Uint8Array.prototype, "set");
    let copied = 0;
    const copy = vi.spyOn(Uint8Array.prototype, "set").mockImplementation(function (
      this: Uint8Array,
      source,
      offset,
    ) {
      if (this.byteLength > 256) copied += source.length;
      nativeSet.call(this, source, offset);
    });
    const controller = new AbortController();
    const steps = encodeStrokeSampleBytesSteps(maximumEncodingSamples(), controller.signal);
    try {
      let step = steps.next();
      while (!step.done && copied === 0) step = steps.next();
      expect(step.done).toBe(false);
      expect(copied).toBe(64 * 1024);
      if (abort) {
        controller.abort();
        expect(() => steps.next()).toThrow();
        expect(copied).toBe(64 * 1024);
      } else {
        while (!step.done) {
          const previous = copied;
          step = steps.next();
          expect(copied - previous).toBeLessThanOrEqual(64 * 1024);
        }
        expect(copied).toBe(262_148);
        expect(step.value).toHaveLength(copied);
      }
    } finally {
      steps.return(new Uint8Array());
      copy.mockRestore();
    }
  });
});

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
