import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  DELTA_VARINT_DECODE_MAX_UNITS_V1,
  createDeltaVarintDecodeProcessorV1,
  createDeltaVarintValidationProcessorV1,
  decodeDeltaVarintStroke,
  encodeDeltaVarintStroke,
  type DeltaVarintSampleV1,
  type EncodedStrokeV1,
} from "../../../src/domain/codecs/delta-varint";

const ONE_COORDINATE_QUANTUM = 0.01;
const RESUMABLE_EXTRA_POINTS = 2;
const ABSENT_DELTA_POINT_BYTES = 3;

const ONE_POINT_ABSENT: EncodedStrokeV1 = {
  codec: "delta-varint-v1",
  pointCount: 1,
  originXQ: 0,
  originYQ: 0,
  pressure: "absent",
  data: "",
};

describe("resumable delta-varint-v1 decoding", () => {
  it("accepts work limits below and at 16,384, then rejects above", () => {
    const encoded = resumableStroke();
    const below = createDeltaVarintDecodeProcessorV1(encoded);
    const at = createDeltaVarintDecodeProcessorV1(encoded);

    expect(below.processNext(DELTA_VARINT_DECODE_MAX_UNITS_V1 - 1)).toBe(false);
    expect(at.processNext(DELTA_VARINT_DECODE_MAX_UNITS_V1)).toBe(false);
    expect(() => at.processNext(DELTA_VARINT_DECODE_MAX_UNITS_V1 + 1)).toThrow(
      /work units/u,
    );
  });

  it("publishes the exact synchronous model only after bounded passes", () => {
    const encoded = resumableStroke();
    const processor = createDeltaVarintDecodeProcessorV1(encoded);
    let passes = 0;

    expect(processor.complete()).toBeUndefined();
    while (!processor.processNext()) {
      passes += 1;
      expect(processor.complete()).toBeUndefined();
    }
    const result = processor.complete();

    expect(passes).toBeGreaterThan(RESUMABLE_EXTRA_POINTS);
    expect(result).toStrictEqual(decodeDeltaVarintStroke(encoded));
    expect(processor.processNext()).toBe(true);
    expect(processor.complete()).toBe(result);
  });

  it("preserves synchronous failures", () => {
    const invalid = { ...ONE_POINT_ABSENT, data: "AA" };
    const incremental = createDeltaVarintDecodeProcessorV1(invalid);
    let incrementalError: unknown;
    try {
      while (!incremental.processNext(1)) {
        // Drive one input or point unit at a time.
      }
    } catch (error: unknown) {
      incrementalError = error;
    }
    let synchronousError: unknown;
    try {
      decodeDeltaVarintStroke(invalid);
    } catch (error: unknown) {
      synchronousError = error;
    }

    expect(incrementalError).toEqual(synchronousError);
  });

  it("rejects a malformed varint immediately after a point-slice boundary", () => {
    const validPointBytes = Array.from(
      {
        length: DELTA_VARINT_DECODE_MAX_UNITS_V1 * ABSENT_DELTA_POINT_BYTES,
      },
      () => 0,
    );
    const encoded: EncodedStrokeV1 = {
      ...ONE_POINT_ABSENT,
      pointCount: DELTA_VARINT_DECODE_MAX_UNITS_V1 + RESUMABLE_EXTRA_POINTS,
      data: rawBase64Url([...validPointBytes, 0]),
    };
    const processor = createDeltaVarintDecodeProcessorV1(encoded);
    const base64Passes = Math.ceil(
      encoded.data.length / DELTA_VARINT_DECODE_MAX_UNITS_V1,
    );

    for (let pass = 0; pass < base64Passes; pass += 1) {
      expect(processor.processNext()).toBe(false);
    }
    expect(processor.processNext()).toBe(false);
    expect(processor.processNext()).toBe(false);
    expect(() => processor.processNext()).toThrow(/truncated varint/u);
  });

  it("releases state and rejects access after disposal", () => {
    const processor = createDeltaVarintValidationProcessorV1(resumableStroke());
    expect(processor.processNext()).toBe(false);
    processor.dispose();

    expect(() => processor.processNext()).toThrow(/disposed/u);
    expect(() => processor.complete()).toThrow(/disposed/u);
  });
});

function resumableStroke(): EncodedStrokeV1 {
  const samples = Array.from(
    { length: DELTA_VARINT_DECODE_MAX_UNITS_V1 + RESUMABLE_EXTRA_POINTS },
    (_, index): DeltaVarintSampleV1 => ({
      x: index * ONE_COORDINATE_QUANTUM,
      y: 0,
      elapsedMs: index,
    }),
  );
  return encodeDeltaVarintStroke(samples, "absent");
}

function rawBase64Url(bytes: readonly number[]): string {
  return Buffer.from(bytes).toString("base64url");
}
