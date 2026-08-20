import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  decodeDeltaVarintStroke,
  encodeDeltaVarintStroke,
  type DeltaVarintSampleV1,
  type EncodedStrokeV1,
} from "../../../src/domain/codecs/delta-varint";

const MAX_POINT_COUNT = 200_000;
const ABOVE_MAX_POINT_COUNT = 200_001;
const MAX_ENCODED_ONE_POINT_CHARACTERS = 27;
const ABOVE_MAX_ENCODED_ONE_POINT_CHARACTERS = 28;
const INT32_MAX = 0x7fff_ffff;
const UINT32_MAX = 0xffff_ffff;
const COORDINATE_SCALE = 100;
const ABSOLUTE_COORDINATE_LIMIT = 10_000_000;
const ABSOLUTE_QUANTIZED_COORDINATE_LIMIT =
  ABSOLUTE_COORDINATE_LIMIT * COORDINATE_SCALE;
const ONE_COORDINATE_QUANTUM = 0.01;
const PRESSURE_SCALE = 1_000;
const BYTE_128 = 0x80;
const BYTE_255 = 0xff;
const OVERFLOW_FINAL_BYTE = 0x10;
const PRESSURE_1001_LOW_BYTE = 0xe9;
const PRESSURE_1001_HIGH_BYTE = 0x07;
const MAX_FINAL_VARINT_PAYLOAD = 0x0f;
const ZIGZAG_POSITIVE_ONE = 2;
const LCG_MULTIPLIER = 1_664_525;
const LCG_INCREMENT = 1_013_904_223;
const UINT32_SPAN = 0x1_0000_0000;
const RANDOM_STEP_SPAN = 2_001;
const RANDOM_STEP_OFFSET = 1_000;
const RANDOM_PRESSURE_SPAN = 1_401;
const RANDOM_PRESSURE_OFFSET = 200;
const FUZZ_POINT_COUNT = 500;
const FUZZ_SEED = 0x19_8b_00_42;

const ONE_POINT_ABSENT: EncodedStrokeV1 = {
  codec: "delta-varint-v1",
  pointCount: 1,
  originXQ: 0,
  originYQ: 0,
  pressure: "absent",
  data: "",
};

describe("delta-varint-v1 golden encoding", () => {
  it("encodes positive, negative, and zero deltas without pressure", () => {
    const samples: readonly DeltaVarintSampleV1[] = [
      { x: 1.23, y: -4.56, elapsedMs: 0 },
      { x: 1.25, y: -4.59, elapsedMs: 10 },
      { x: 1.25, y: -4.59, elapsedMs: 10 },
      { x: -0.05, y: 0.01, elapsedMs: 300 },
    ];

    expect(encodeDeltaVarintStroke(samples, "absent")).toEqual({
      codec: "delta-varint-v1",
      pointCount: 4,
      originXQ: 123,
      originYQ: -456,
      pressure: "absent",
      data: "BAUKAAAAgwKYB6IC",
    });
  });

  it("encodes the first and subsequent pressure values in wire order", () => {
    const samples: readonly DeltaVarintSampleV1[] = [
      { x: 0, y: 0, pressure: 0.5, elapsedMs: 0 },
      { x: 0.01, y: -0.02, pressure: 0.5, elapsedMs: 128 },
    ];

    expect(encodeDeltaVarintStroke(samples, "present")).toEqual({
      codec: "delta-varint-v1",
      pointCount: 2,
      originXQ: 0,
      originYQ: 0,
      pressure: "present",
      data: "9AMCA_QDgAE",
    });
  });

  it("uses empty data for one constant-width point and pressure data otherwise", () => {
    expect(
      encodeDeltaVarintStroke([{ x: 1, y: -1, elapsedMs: 0 }], "absent"),
    ).toEqual({ ...ONE_POINT_ABSENT, originXQ: 100, originYQ: -100 });
    expect(
      encodeDeltaVarintStroke(
        [{ x: 1, y: -1, pressure: 0.25, elapsedMs: 0 }],
        "present",
      ),
    ).toEqual({
      ...ONE_POINT_ABSENT,
      originXQ: 100,
      originYQ: -100,
      pressure: "present",
      data: "-gE",
    });
  });

  it("uses minimal five-byte varints at reachable coordinate boundaries", () => {
    const encoded = encodeDeltaVarintStroke(
      [
        { x: 0, y: 0, elapsedMs: 0 },
        { x: 10_000_000, y: -10_000_000, elapsedMs: 0 },
      ],
      "absent",
    );

    expect(encoded.data).toBe("gKjWuQf_p9a5BwA");
    expect(decodeDeltaVarintStroke(encoded).points[1]).toEqual({
      x: 10_000_000,
      y: -10_000_000,
      elapsedMs: 0,
    });
  });
});

describe("delta-varint-v1 quantization and boundaries", () => {
  it("rounds coordinates immediately below, at, and above half a quantum", () => {
    const below = encodeDeltaVarintStroke(
      [{ x: 0.0049, y: 0, elapsedMs: 0 }],
      "absent",
    );
    const at = encodeDeltaVarintStroke(
      [{ x: 0.005, y: 0, elapsedMs: 0 }],
      "absent",
    );
    const above = encodeDeltaVarintStroke(
      [{ x: 0.0051, y: 0, elapsedMs: 0 }],
      "absent",
    );

    expect([below.originXQ, at.originXQ, above.originXQ]).toEqual([0, 1, 1]);
  });

  it("clamps pressure below, at, and above its declared range", () => {
    const encoded = encodeDeltaVarintStroke(
      [
        { x: 0, y: 0, pressure: -0.1, elapsedMs: 0 },
        { x: 0, y: 0, pressure: 1, elapsedMs: 1 },
        { x: 0, y: 0, pressure: 1.1, elapsedMs: 2 },
      ],
      "present",
    );

    expect(decodeDeltaVarintStroke(encoded).points).toEqual([
      { x: 0, y: 0, pressure: 0, elapsedMs: 0 },
      { x: 0, y: 0, pressure: 1, elapsedMs: 1 },
      { x: 0, y: 0, pressure: 1, elapsedMs: 2 },
    ]);
  });

  it("accepts point counts immediately below and at the limit, then rejects above", () => {
    const sample: DeltaVarintSampleV1 = { x: 0, y: 0, elapsedMs: 0 };
    const samples = Array.from({ length: MAX_POINT_COUNT - 1 }, () => sample);

    expect(encodeDeltaVarintStroke(samples, "absent").pointCount).toBe(
      MAX_POINT_COUNT - 1,
    );
    samples.push(sample);
    expect(encodeDeltaVarintStroke(samples, "absent").pointCount).toBe(
      MAX_POINT_COUNT,
    );
    samples.push(sample);
    expect(samples).toHaveLength(ABOVE_MAX_POINT_COUNT);
    expect(() => encodeDeltaVarintStroke(samples, "absent")).toThrow(
      /point count/u,
    );
  });

  it("permits equal timestamps and rejects decreasing or overflowing time", () => {
    expect(() =>
      encodeDeltaVarintStroke(
        [
          { x: 0, y: 0, elapsedMs: 0 },
          { x: 0, y: 0, elapsedMs: 0 },
        ],
        "absent",
      ),
    ).not.toThrow();
    expect(() =>
      encodeDeltaVarintStroke(
        [
          { x: 0, y: 0, elapsedMs: 0 },
          { x: 0, y: 0, elapsedMs: 1 },
          { x: 0, y: 0, elapsedMs: 0 },
        ],
        "absent",
      ),
    ).toThrow(/Timestamp delta/u);
    expect(() =>
      encodeDeltaVarintStroke(
        [{ x: 0, y: 0, elapsedMs: UINT32_MAX + 1 }],
        "absent",
      ),
    ).toThrow(/Timestamp/u);
  });
});

describe("delta-varint-v1 deterministic round trips", () => {
  it("preserves every canonical golden record through decode then encode", () => {
    const records: readonly EncodedStrokeV1[] = [
      ONE_POINT_ABSENT,
      {
        codec: "delta-varint-v1",
        pointCount: 2,
        originXQ: 0,
        originYQ: 0,
        pressure: "present",
        data: "9AMCA_QDgAE",
      },
      {
        codec: "delta-varint-v1",
        pointCount: 2,
        originXQ: 0,
        originYQ: 0,
        pressure: "absent",
        data: "gKjWuQf_p9a5BwA",
      },
    ];

    for (const record of records) {
      const decoded = decodeDeltaVarintStroke(record);
      expect(encodeDeltaVarintStroke(decoded.points, decoded.pressure)).toEqual(
        record,
      );
      expect(Object.isFrozen(decoded)).toBe(true);
      expect(Object.isFrozen(decoded.points)).toBe(true);
      expect(decoded.points.every(Object.isFrozen)).toBe(true);
    }
  });

  it("passes a reproducible seeded pressure-stroke property fixture", () => {
    const random = createRandom(FUZZ_SEED);
    const samples: DeltaVarintSampleV1[] = [];
    let xQ = 0;
    let yQ = 0;
    let elapsedMs = 0;
    for (let index = 0; index < FUZZ_POINT_COUNT; index += 1) {
      xQ += (random() % RANDOM_STEP_SPAN) - RANDOM_STEP_OFFSET;
      yQ += (random() % RANDOM_STEP_SPAN) - RANDOM_STEP_OFFSET;
      if (index > 0) elapsedMs += random() % PRESSURE_SCALE;
      samples.push({
        x: xQ / COORDINATE_SCALE,
        y: yQ / COORDINATE_SCALE,
        pressure:
          ((random() % RANDOM_PRESSURE_SPAN) - RANDOM_PRESSURE_OFFSET) /
          PRESSURE_SCALE,
        elapsedMs,
      });
    }

    const encoded = encodeDeltaVarintStroke(samples, "present");
    const decoded = decodeDeltaVarintStroke(encoded);
    expect(encodeDeltaVarintStroke(decoded.points, decoded.pressure)).toEqual(
      encoded,
    );
    expect(decoded.points).toHaveLength(FUZZ_POINT_COUNT);
  });
});

describe("delta-varint-v1 malicious input rejection", () => {
  it("rejects malformed encoder samples and pressure-mode mismatches", () => {
    expect(() => encodeDeltaVarintStroke([], "absent")).toThrow(/at least/u);
    expect(() =>
      encodeDeltaVarintStroke(
        [null] as unknown as readonly DeltaVarintSampleV1[],
        "absent",
      ),
    ).toThrow(/plain data/u);
    expect(() =>
      encodeDeltaVarintStroke(
        [{ x: Number.NaN, y: 0, elapsedMs: 0 }],
        "absent",
      ),
    ).toThrow(/finite/u);
    expect(() =>
      encodeDeltaVarintStroke(
        [{ x: 0, y: 0, pressure: 0.5, elapsedMs: 0 }],
        "absent",
      ),
    ).toThrow(/pressure mode/u);
    expect(() =>
      encodeDeltaVarintStroke([{ x: 0, y: 0, elapsedMs: 0 }], "present"),
    ).toThrow(/pressure mode/u);
    expect(() =>
      encodeDeltaVarintStroke(
        [{ x: 0, y: 0, pressure: Number.POSITIVE_INFINITY, elapsedMs: 0 }],
        "present",
      ),
    ).toThrow(/finite/u);
  });

  it("rejects invalid quantized coordinates and first timestamps", () => {
    expect(() =>
      encodeDeltaVarintStroke([{ x: 0, y: 0, elapsedMs: 1 }], "absent"),
    ).toThrow(/first stroke timestamp/u);
    expect(() =>
      encodeDeltaVarintStroke(
        [
          {
            x: ABSOLUTE_COORDINATE_LIMIT + ONE_COORDINATE_QUANTUM,
            y: 0,
            elapsedMs: 0,
          },
        ],
        "absent",
      ),
    ).toThrow(/coordinate limit/u);
  });
});

describe("delta-varint-v1 malicious decoder rejection", () => {
  it.each([
    null,
    {},
    { ...ONE_POINT_ABSENT, codec: "unknown" },
    { ...ONE_POINT_ABSENT, pointCount: 0 },
    { ...ONE_POINT_ABSENT, pointCount: ABOVE_MAX_POINT_COUNT },
    { ...ONE_POINT_ABSENT, originXQ: INT32_MAX + 1 },
    { ...ONE_POINT_ABSENT, pressure: "sometimes" },
    { ...ONE_POINT_ABSENT, data: 1 },
    { ...ONE_POINT_ABSENT, extra: true },
  ])("rejects malformed closed record %#", (record) => {
    expect(() => decodeDeltaVarintStroke(record)).toThrow();
  });

  it.each(["=", "+", "/", "A", "AB", "AA=="])(
    "rejects invalid or noncanonical base64url data %s",
    (data) => {
      expect(() =>
        decodeDeltaVarintStroke({ ...ONE_POINT_ABSENT, data }),
      ).toThrow();
    },
  );

  it("rejects non-minimal, overflowing, overlong, truncated, and trailing varints", () => {
    const invalidPressureStreams = [
      [BYTE_128, 0],
      [BYTE_255, BYTE_255, BYTE_255, BYTE_255, OVERFLOW_FINAL_BYTE],
      [BYTE_128, BYTE_128, BYTE_128, BYTE_128, BYTE_128, 0],
    ];
    for (const bytes of invalidPressureStreams) {
      expect(() =>
        decodeDeltaVarintStroke({
          ...ONE_POINT_ABSENT,
          pressure: "present",
          data: rawBase64Url(bytes),
        }),
      ).toThrow(/varint/u);
    }
    expect(() =>
      decodeDeltaVarintStroke({
        ...ONE_POINT_ABSENT,
        pointCount: 2,
      }),
    ).toThrow(/truncated/u);
    expect(() =>
      decodeDeltaVarintStroke({ ...ONE_POINT_ABSENT, data: "AA" }),
    ).toThrow(/trailing/u);
  });

  it("rejects pressure, coordinate, timestamp, and byte-limit overflow", () => {
    expect(() =>
      decodeDeltaVarintStroke({
        ...ONE_POINT_ABSENT,
        pressure: "present",
        data: rawBase64Url([PRESSURE_1001_LOW_BYTE, PRESSURE_1001_HIGH_BYTE]),
      }),
    ).toThrow(/pressure/u);
    expect(() =>
      decodeDeltaVarintStroke({
        ...ONE_POINT_ABSENT,
        pointCount: 2,
        originXQ: ABSOLUTE_QUANTIZED_COORDINATE_LIMIT,
        data: rawBase64Url([ZIGZAG_POSITIVE_ONE, 0, 0]),
      }),
    ).toThrow(/X coordinate/u);
    expect(() => decodeDeltaVarintStroke(timestampOverflowRecord())).toThrow(
      /Timestamp/u,
    );
    const atCharacterLimit = "A".repeat(MAX_ENCODED_ONE_POINT_CHARACTERS);
    expect(atCharacterLimit).toHaveLength(MAX_ENCODED_ONE_POINT_CHARACTERS);
    expect(() =>
      decodeDeltaVarintStroke({
        ...ONE_POINT_ABSENT,
        data: atCharacterLimit,
      }),
    ).toThrow(/trailing/u);
    expect(() =>
      decodeDeltaVarintStroke({
        ...ONE_POINT_ABSENT,
        data: "A".repeat(ABOVE_MAX_ENCODED_ONE_POINT_CHARACTERS),
      }),
    ).toThrow(/encoded byte limit/u);
  });
});

function timestampOverflowRecord(): EncodedStrokeV1 {
  return {
    ...ONE_POINT_ABSENT,
    pointCount: 3,
    data: rawBase64Url([
      0,
      0,
      BYTE_255,
      BYTE_255,
      BYTE_255,
      BYTE_255,
      MAX_FINAL_VARINT_PAYLOAD,
      0,
      0,
      1,
    ]),
  };
}

function rawBase64Url(bytes: readonly number[]): string {
  return Buffer.from(bytes).toString("base64url");
}

function createRandom(seed: number): () => number {
  let state = seed;
  return (): number => {
    state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % UINT32_SPAN;
    return state;
  };
}
