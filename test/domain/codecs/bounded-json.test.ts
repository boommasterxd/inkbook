import { describe, expect, it } from "vitest";

import {
  BOUNDED_JSON_PROCESS_MAX_UTF16_UNITS,
  type BoundedJsonLimits,
  createBoundedJsonProcessor,
  parseBoundedJson,
} from "../../../src/domain/codecs/bounded-json";

const MAX_NESTING = 64;
const DEFAULT_LIMIT = 10_000;
const EXPECTED_POSITIVE_INTEGER = 12;
const EXPECTED_NEGATIVE_DECIMAL = -3.5;
const EXPECTED_POSITIVE_EXPONENT = 600;
const EXPECTED_NEGATIVE_EXPONENT = 0.07;
const EXPECTED_NUMBERS = [
  0,
  -0,
  EXPECTED_POSITIVE_INTEGER,
  EXPECTED_NEGATIVE_DECIMAL,
  EXPECTED_POSITIVE_EXPONENT,
  EXPECTED_NEGATIVE_EXPONENT,
];
const THREE_ITEMS = 3;
const MALICIOUS_VALUE_SIZE = 1_000;
const FUZZ_SEED = 0x1a2b3c4d;
const FUZZ_CASES = 500;
const RANDOM_MULTIPLIER = 1_664_525;
const RANDOM_INCREMENT = 1_013_904_223;
const RANDOM_DIVISOR = 0x1_0000_0000;
const MAX_GENERATED_DEPTH = 3;
const LEAF_KIND_COUNT = 5;
const ALL_KIND_COUNT = 7;
const RANDOM_MIDPOINT = 0.5;
const REAL_MAGNITUDE = 1e20;
const INTEGER_MAGNITUDE = 1_000_000;
const MAX_COLLECTION_SIZE = 5;
const MAX_STRING_SIZE = 8;
const RESUMABLE_STRING_SIZE = 64;
const TWO_UTF16_UNITS = 2;
const NEGATIVE_WORK_LIMIT = -1;
const FRACTIONAL_WORK_LIMIT = 1.5;
const NULL_KIND = 0;
const BOOLEAN_KIND = 1;
const NUMBER_KIND = 2;
const STRING_KIND = 3;
const INTEGER_KIND = 4;
const ARRAY_KIND = 5;
const DEFAULT_LIMITS: BoundedJsonLimits = {
  maxUtf8Bytes: DEFAULT_LIMIT,
  maxNesting: MAX_NESTING,
  maxStringUtf16Units: DEFAULT_LIMIT,
  maxArrayItems: DEFAULT_LIMIT,
  maxObjectMembers: DEFAULT_LIMIT,
  maxObjectMembersPerObject: 64,
  maxArrays: DEFAULT_LIMIT,
  maxObjects: DEFAULT_LIMIT,
};

describe("bounded JSON parsing", () => {
  it("parses every token kind, whitespace, and string escape", () => {
    const input =
      ' {"null":null,"booleans":[true,false],"numbers":[0,-0,12,-3.5,6e2,7E-2],"escapes":"\\"\\\\\\/\\b\\f\\n\\r\\t\\u0061\\uD83D\\uDE00"}\n';

    const result = parseBoundedJson(input, DEFAULT_LIMITS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.counters)).toBe(true);
    expect(result.value).toEqual({
      null: null,
      booleans: [true, false],
      numbers: EXPECTED_NUMBERS,
      escapes: '"\\/\b\f\n\r\ta😀',
    });
    expect(
      Object.is((result.value as { numbers: number[] }).numbers[1], -0),
    ).toBe(true);
    expect(result.counters).toMatchObject({
      maximumNesting: 2,
      arrays: 2,
      objects: 1,
      arrayItems: 8,
      objectMembers: 4,
    });
  });

  it("creates frozen null-prototype records for unsafe property names", () => {
    const result = parseBoundedJson(
      '{"__proto__":{"polluted":true},"constructor":1}',
      DEFAULT_LIMITS,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.getPrototypeOf(result.value)).toBeNull();
    expect(Object.isFrozen(result.value)).toBe(true);
    const nested = (result.value as Record<string, unknown>).__proto__;
    expect(Object.isFrozen(nested)).toBe(true);
    expect(nested).toEqual({
      polluted: true,
    });
  });

  it("deeply freezes every parsed container", () => {
    const result = parseBoundedJson(
      '{"array":[{"nested":[]}]}',
      DEFAULT_LIMITS,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const root = result.value as Record<string, unknown>;
    const array = root.array as readonly unknown[];
    const record = array[0] as Record<string, unknown>;
    expect([root, array, record, record.nested].every(Object.isFrozen)).toBe(
      true,
    );
  });

  it.each([
    '{"same":1,"same":2}',
    '{"a":1,"\\u0061":2}',
    '{"😀":1,"\\uD83D\\uDE00":2}',
  ])("rejects decoded duplicate object keys in %s", (input) => {
    expect(parseBoundedJson(input, DEFAULT_LIMITS)).toMatchObject({
      ok: false,
      error: { code: "duplicate-key" },
    });
  });

  it("counts exact UTF-8 bytes below, at, and above the limit", () => {
    const input = '"ä😀"';
    const byteLength = 8;

    expect(
      parseBoundedJson(input, {
        ...DEFAULT_LIMITS,
        maxUtf8Bytes: byteLength - 1,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "utf8-byte-limit" },
      counters: { utf8Bytes: byteLength },
    });
    expect(
      parseBoundedJson(input, { ...DEFAULT_LIMITS, maxUtf8Bytes: byteLength }),
    ).toMatchObject({ ok: true, counters: { utf8Bytes: byteLength } });
    expect(
      parseBoundedJson(input, {
        ...DEFAULT_LIMITS,
        maxUtf8Bytes: byteLength + 1,
      }),
    ).toMatchObject({ ok: true, counters: { utf8Bytes: byteLength } });
    expect(parseBoundedJson('"€"', DEFAULT_LIMITS)).toMatchObject({ ok: true });
  });
});

describe("bounded JSON processing", () => {
  it("resumes one bounded UTF-16 slice at a time and materializes once", () => {
    const input = `{"value":"${"x".repeat(RESUMABLE_STRING_SIZE)}"}`;
    const processor = createBoundedJsonProcessor(input, DEFAULT_LIMITS);
    let slices = 0;

    expect(processor.complete()).toBeUndefined();
    while (!processor.processNext(1)) slices += 1;

    const completed = processor.complete();
    expect(slices).toBeGreaterThan(input.length);
    expect(completed).toEqual(parseBoundedJson(input, DEFAULT_LIMITS));
    expect(processor.complete()).toBe(completed);
    expect(processor.processNext(1)).toBe(true);
    expect(processor.complete()).toBe(completed);
  });

  it("caps caller work requests at the fixed parser chunk limit", () => {
    const input = `"${"x".repeat(BOUNDED_JSON_PROCESS_MAX_UTF16_UNITS)}"`;
    const processor = createBoundedJsonProcessor(input, DEFAULT_LIMITS);

    expect(processor.processNext(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(processor.complete()).toBeUndefined();
  });

  it("finishes raw admission before constructing bounded values", () => {
    const processor = createBoundedJsonProcessor("[0]", {
      ...DEFAULT_LIMITS,
      maxArrayItems: 0,
    });

    expect(processor.processNext(THREE_ITEMS)).toBe(false);
    expect(processor.complete()).toBeUndefined();
    expect(processor.processNext(THREE_ITEMS)).toBe(true);
    expect(processor.complete()).toMatchObject({
      ok: false,
      error: { code: "array-item-limit" },
    });
  });

  it("validates surrogate pairs split across admission slices", () => {
    const valid = createBoundedJsonProcessor('"😀"', DEFAULT_LIMITS);
    const invalid = createBoundedJsonProcessor('"\ud800x"', DEFAULT_LIMITS);

    while (!valid.processNext(1)) {
      // Drive the deliberately smallest supported slice.
    }
    expect(valid.complete()).toMatchObject({ ok: true });
    expect(invalid.processNext(TWO_UTF16_UNITS)).toBe(false);
    expect(invalid.processNext(1)).toBe(true);
    expect(invalid.complete()).toMatchObject({
      ok: false,
      error: { code: "invalid-unicode", offset: 1 },
    });
  });

  it.each([
    0,
    NEGATIVE_WORK_LIMIT,
    FRACTIONAL_WORK_LIMIT,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid per-slice work limits: %s", (limit) => {
    const processor = createBoundedJsonProcessor("null", DEFAULT_LIMITS);

    expect(() => processor.processNext(limit)).toThrow(RangeError);
    expect(processor.complete()).toBeUndefined();
  });
});

describe("bounded JSON limits", () => {
  it("enforces nesting below, at, and above the configured and hard limits", () => {
    const atLimit = nestedArrays(MAX_NESTING);

    expect(
      parseBoundedJson(nestedArrays(MAX_NESTING - 1), DEFAULT_LIMITS),
    ).toMatchObject({ ok: true });
    expect(parseBoundedJson(atLimit, DEFAULT_LIMITS)).toMatchObject({
      ok: true,
    });
    expect(
      parseBoundedJson(nestedArrays(MAX_NESTING + 1), DEFAULT_LIMITS),
    ).toMatchObject({ ok: false, error: { code: "nesting-limit" } });
    expect(
      parseBoundedJson(atLimit, {
        ...DEFAULT_LIMITS,
        maxNesting: MAX_NESTING + 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-limits" } });
  });

  it("enforces decoded string units below, at, and above the limit", () => {
    const limits = { ...DEFAULT_LIMITS, maxStringUtf16Units: 2 };

    expect(parseBoundedJson('"a"', limits)).toMatchObject({ ok: true });
    expect(parseBoundedJson('"😀"', limits)).toMatchObject({ ok: true });
    expect(parseBoundedJson('"a😀"', limits)).toMatchObject({
      ok: false,
      error: { code: "string-limit" },
    });
    expect(parseBoundedJson('"\\uD83D\\uDE00"', limits)).toMatchObject({
      ok: true,
      counters: { maximumStringUtf16Units: 2 },
    });
  });

  it.each([
    ["maxArrayItems", "[0,1]", "[0,1,2]", "[0,1,2,3]", "array-item-limit"],
    [
      "maxObjectMembers",
      '{"a":0,"b":1}',
      '{"a":0,"b":1,"c":2}',
      '{"a":0,"b":1,"c":2,"d":3}',
      "object-member-limit",
    ],
    ["maxArrays", "[[]]", "[[],[]]", "[[],[],[]]", "array-limit"],
    ["maxObjects", "[{},{}]", "[{},{},{}]", "[{},{},{},{}]", "object-limit"],
  ] as const)(
    "enforces %s and returns counters without a partial value",
    (limit, belowInput, atInput, aboveInput, code) => {
      const limits = { ...DEFAULT_LIMITS, [limit]: THREE_ITEMS };
      const below = parseBoundedJson(belowInput, limits);
      const at = parseBoundedJson(atInput, limits);
      const above = parseBoundedJson(aboveInput, limits);

      expect(below.ok).toBe(true);
      expect(at.ok).toBe(true);
      expect(above).toMatchObject({ ok: false, error: { code } });
      expect("value" in above).toBe(false);
    },
  );
});

describe("bounded JSON rejection", () => {
  it.each([
    "",
    "+1",
    ".1",
    "01",
    "-01",
    "1.",
    "1e",
    "1e+",
    "tru",
    "NaN",
    "Infinity",
    "true false",
    "[]x",
    "[,1]",
    "[1,]",
    "[1 2]",
    "{a:1}",
    '{"a" 1}',
    '{"a":1,}',
    '"unterminated',
    '"line\nfeed"',
    '"\\x20"',
    '"\\u12x4"',
    '"\\u12"',
  ])("rejects invalid JSON grammar: %s", (input) => {
    expect(parseBoundedJson(input, DEFAULT_LIMITS).ok).toBe(false);
  });

  it.each(["1e309", "-1e309"])(
    "rejects a syntactically valid number with a non-finite result: %s",
    (input) => {
      expect(parseBoundedJson(input, DEFAULT_LIMITS)).toMatchObject({
        ok: false,
        error: { code: "non-finite-number" },
      });
    },
  );

  it("accepts finite underflow and leaves unsafe integers to model validation", () => {
    expect(parseBoundedJson("1e-400", DEFAULT_LIMITS)).toMatchObject({
      ok: true,
      value: Number("1e-400"),
    });
    expect(parseBoundedJson("9007199254740993", DEFAULT_LIMITS)).toMatchObject({
      ok: true,
      value: Number("9007199254740993"),
    });
  });

  it.each([
    '"\\uD800"',
    '"\\uDC00"',
    '"\\uD800\\u0041"',
    '"\ud800"',
    '"\udc00"',
  ])("rejects invalid Unicode: %s", (input) => {
    expect(parseBoundedJson(input, DEFAULT_LIMITS)).toMatchObject({
      ok: false,
      error: { code: "invalid-unicode" },
    });
  });

  it("rejects huge malicious values at their earliest configured boundary", () => {
    const hugeString = `"${"x".repeat(MALICIOUS_VALUE_SIZE)}"`;
    const hugeArray = `[${"0,".repeat(MALICIOUS_VALUE_SIZE - 1)}0]`;
    const stringResult = parseBoundedJson(hugeString, {
      ...DEFAULT_LIMITS,
      maxStringUtf16Units: 16,
    });

    expect(stringResult).toMatchObject({
      ok: false,
      error: { code: "string-limit" },
    });
    if (stringResult.ok) return;
    expect(stringResult.error.offset).toBeLessThan(MALICIOUS_VALUE_SIZE);
    expect(
      parseBoundedJson(hugeArray, { ...DEFAULT_LIMITS, maxArrayItems: 16 }),
    ).toMatchObject({ ok: false, error: { code: "array-item-limit" } });
  });

  it("rejects invalid caller limits", () => {
    const incompleteLimits: Partial<BoundedJsonLimits> = {};

    expect(
      parseBoundedJson("null", { ...DEFAULT_LIMITS, maxObjects: -1 }),
    ).toMatchObject({ ok: false, error: { code: "invalid-limits" } });
    expect(
      parseBoundedJson("null", {
        ...DEFAULT_LIMITS,
        maxUtf8Bytes: Number.POSITIVE_INFINITY,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-limits" } });
    expect(
      parseBoundedJson("null", incompleteLimits as BoundedJsonLimits),
    ).toMatchObject({ ok: false, error: { code: "invalid-limits" } });
    const failed = parseBoundedJson("", DEFAULT_LIMITS);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(Object.isFrozen(failed)).toBe(true);
    expect(Object.isFrozen(failed.error)).toBe(true);
    expect(Object.isFrozen(failed.counters)).toBe(true);
  });
});

describe("bounded JSON differential parsing", () => {
  it("matches JSON.parse for seeded safe JSON values", () => {
    const random = seededRandom(FUZZ_SEED);
    for (let index = 0; index < FUZZ_CASES; index += 1) {
      const encoded = JSON.stringify(generateValue(random, 0));
      const expected = JSON.parse(encoded) as unknown;
      const actual = parseBoundedJson(encoded, DEFAULT_LIMITS);

      expect(actual.ok, encoded).toBe(true);
      if (actual.ok) expect(actual.value).toEqual(expected);
    }
  });
});

function nestedArrays(depth: number): string {
  return `${"[".repeat(depth)}null${"]".repeat(depth)}`;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return (): number => {
    state = (Math.imul(state, RANDOM_MULTIPLIER) + RANDOM_INCREMENT) >>> 0;
    return state / RANDOM_DIVISOR;
  };
}

function generateValue(random: () => number, depth: number): unknown {
  const kind =
    depth >= MAX_GENERATED_DEPTH
      ? Math.floor(random() * LEAF_KIND_COUNT)
      : Math.floor(random() * ALL_KIND_COUNT);
  if (kind === NULL_KIND) return null;
  if (kind === BOOLEAN_KIND) return random() < RANDOM_MIDPOINT;
  if (kind === NUMBER_KIND) {
    return (random() - RANDOM_MIDPOINT) * REAL_MAGNITUDE;
  }
  if (kind === STRING_KIND) return randomString(random);
  if (kind === INTEGER_KIND) {
    return Math.trunc((random() - RANDOM_MIDPOINT) * INTEGER_MAGNITUDE);
  }
  if (kind === ARRAY_KIND) {
    return Array.from(
      { length: Math.floor(random() * MAX_COLLECTION_SIZE) },
      () => generateValue(random, depth + 1),
    );
  }
  const value: Record<string, unknown> = {};
  const size = Math.floor(random() * MAX_COLLECTION_SIZE);
  for (let index = 0; index < size; index += 1) {
    value[`${randomString(random)}-${String(index)}`] = generateValue(
      random,
      depth + 1,
    );
  }
  return value;
}

function randomString(random: () => number): string {
  const alphabet = ['"', "\\", "\n", "a", "ä", "😀"];
  return Array.from(
    { length: Math.floor(random() * MAX_STRING_SIZE) },
    () => alphabet[Math.floor(random() * alphabet.length)] ?? "a",
  ).join("");
}
