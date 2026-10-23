import { describe, expect, it } from "vitest";
import {
  decodeStrokeSamplesSteps,
  encodeStrokeSampleBytesSteps,
  encodeStrokeSamples,
  encodeStrokeSamplesSteps,
} from "../../../../../src/persistence/serialization/metadata/stroke-sample-codec";
import { decodeStrokeSamples } from "../../../../fixtures/persistence/stroke-sample-codec";
import {
  SampleBase64ByteWriter,
  SampleBase64Writer,
} from "../../../../../src/persistence/serialization/metadata/sample-base64";
import { finishGeometrySteps } from "../../../../fixtures/domain/geometry-steps";

describe("compact stroke sample codec", () => {
  it("round trips coordinates and pressure at their stored precision", () => {
    const input = new Float64Array([0, -0.001, 0.1235, 1.235, -2.345, 1, -3.456, 4.568, 0]);

    const encoded = encodeStrokeSamples(input);

    expect(decodeStrokeSamples(encoded)).toEqual(input);
    expect(encodeStrokeSamples(new Float64Array([0, 0, 0, 1, -1, 1]))).toBe("AgAAANAPzw+QTg==");
  });

  it("preserves the coordinate and point-count boundaries", () => {
    const points = new Float64Array([1_000_000, -1_000_000, 1, -1_000_000, 1_000_000, 0]);

    expect(decodeStrokeSamples(encodeStrokeSamples(points))).toEqual(points);

    const maximum = new Float64Array(16_384 * 3);
    for (let point = 0; point < maximum.length / 3; point += 1) {
      maximum[point * 3] = point / 1000;
      maximum[point * 3 + 1] = point === 0 ? 0 : -point / 1000;
      maximum[point * 3 + 2] = (point % 10) / 10;
    }
    const encoded = encodeStrokeSamples(maximum);
    expect(encoded).toBe(referenceStrokeEncoding(maximum));
    expect(
      new TextDecoder().decode(finishGeometrySteps(encodeStrokeSampleBytesSteps(maximum))),
    ).toBe(encoded);
    expect(decodeStrokeSamples(encoded)).toEqual(maximum);
  });

  it.each(
    [
      [],
      [0, 0],
      [0, 0, 0, 1],
      [Number.NaN, 0, 0],
      [0, Number.POSITIVE_INFINITY, 0],
      [1_000_000.001, 0, 0],
      [0, 0, -0.001],
      [0, 0, 1.001],
      [0.0001, 0, 0],
      [0, 0, 0.123456],
    ].map((values) => [values]),
  )("rejects invalid sample input %j", (values) => {
    expect(() => encodeStrokeSamples(values)).toThrow(RangeError);
    expect(() => finishGeometrySteps(encodeStrokeSampleBytesSteps(values))).toThrow(RangeError);
  });

  it("rejects a stroke with more than the maximum point count", () => {
    expect(() => encodeStrokeSamples(new Float64Array(16_385 * 3))).toThrow(RangeError);
  });

  it.each([
    [[0x00]],
    [[0x81, 0x80, 0x01]],
    [[0x81, 0x00]],
    [[0x01, 0x00]],
    [[0x01, 0x00, 0x00, 0x00, 0x00]],
    [[0x01, 0x80, 0x80, 0x80, 0x80, 0x10, 0x00, 0x00]],
    [[0x01, 0x00, 0x00, 0x91, 0x4e]],
    [[0x01, 0x80, 0x80, 0x80, 0x80, 0x0f, 0x00, 0x00]],
  ])("rejects malformed sample bytes %j", (bytes) => {
    expect(() => decodeStrokeSamples(base64(bytes))).toThrow(RangeError);
  });

  it.each(["", "AQAAANAPzw+QTg", "AQAAANAPzw+QTg===", "AQAAANPzw+QTg==", "AQAA\nANAPzw+QTg=="])(
    "rejects non-canonical Base64 %j",
    (input) => {
      expect(() => decodeStrokeSamples(input)).toThrow(RangeError);
    },
  );

  it("checks cancellation before work and at cooperative step boundaries", () => {
    const points = new Float64Array(257 * 3);
    const before = new AbortController();
    before.abort();
    expect(() => encodeStrokeSamplesSteps(points, before.signal).next()).toThrow();
    expect(() =>
      decodeStrokeSamplesSteps(encodeStrokeSamples(points), before.signal).next(),
    ).toThrow();

    const encodeAbort = new AbortController();
    const encoder = encodeStrokeSamplesSteps(points, encodeAbort.signal);
    expect(encoder.next().done).toBe(false);
    encodeAbort.abort();
    expect(() => encoder.next()).toThrow();

    const decodeAbort = new AbortController();
    const decoder = decodeStrokeSamplesSteps(encodeStrokeSamples(points), decodeAbort.signal);
    expect(decoder.next().done).toBe(false);
    decodeAbort.abort();
    expect(() => decoder.next()).toThrow();
  });
});

describe("compact sample Base64 writer", () => {
  it.each([0, 1, 2, 3, 190, 191, 192, 193, 194, 255, 256, 383, 384, 385, 196_611])(
    "matches native Base64 for %s bytes across padding and chunk boundaries",
    (length) => {
      const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
      const writer = new SampleBase64Writer();
      const byteWriter = new SampleBase64ByteWriter();
      for (const byte of bytes) {
        writer.append(byte);
        byteWriter.append(byte);
      }
      expect(writer.finish()).toBe(base64(bytes));
      const encoded = byteWriter.finish();
      expect(new TextDecoder().decode(encoded)).toBe(base64(bytes));
      expect(encoded.buffer.byteLength).toBe(encoded.byteLength);
    },
  );
});

describe("compact stroke sample point budget", () => {
  it("decodes when the remaining document point budget exactly matches the stroke", () => {
    const encoded = encodeStrokeSamples(new Float64Array([0, 0, 0, 1, -1, 1]));
    const decoder = decodeStrokeSamplesSteps(encoded, undefined, 2);

    expect(decoder.next()).toMatchObject({
      done: true,
      value: new Float64Array([0, 0, 0, 1, -1, 1]),
    });
  });

  it.each([0, 1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects an invalid or insufficient remaining point budget %s",
    (maximumPoints) => {
      const encoded = encodeStrokeSamples(new Float64Array([0, 0, 0, 1, -1, 1]));

      expect(() => decodeStrokeSamplesSteps(encoded, undefined, maximumPoints).next()).toThrow(
        RangeError,
      );
    },
  );
});

function base64(bytes: ArrayLike<number>): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function referenceStrokeEncoding(points: Float64Array): string {
  const bytes: number[] = [];
  const append = (integer: number): void => {
    do {
      const digit = integer % 128;
      integer = Math.floor(integer / 128);
      bytes.push(digit | (integer > 0 ? 128 : 0));
    } while (integer > 0);
  };
  append(points.length / 3);
  let previousX = 0;
  let previousY = 0;
  for (let index = 0; index < points.length; index += 3) {
    const x = Math.round(points[index]! * 1000);
    const y = Math.round(points[index + 1]! * 1000);
    for (const delta of [x - previousX, y - previousY]) {
      append(delta < 0 ? -delta * 2 - 1 : delta * 2);
    }
    append(Math.round(points[index + 2]! * 10_000));
    previousX = x;
    previousY = y;
  }
  return base64(bytes);
}
