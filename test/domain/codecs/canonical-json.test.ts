import { describe, expect, it } from "vitest";

import {
  canonicalizeJson,
  encodeCanonicalJson,
  encodeCanonicalSidecarJson,
} from "../../../src/domain/codecs/canonical-json";

const MAX_NESTING = 64;
const ABOVE_MAX_NESTING = 65;
const LAST_INDEX = -1;
const RFC_LARGE_DECIMAL = Number("333333333.33333329");
const RFC_LARGE_EXPONENT = 1e30;
const RFC_TRAILING_ZERO = 4.5;
const RFC_SMALL_DECIMAL = 0.002;
const RFC_SMALL_EXPONENT = 1e-27;
const UNSUPPORTED_BIGINT = BigInt(1);

describe("RFC 8785 canonical JSON", () => {
  it("matches the RFC 8785 primitive serialization fixture", () => {
    const value = {
      numbers: [
        RFC_LARGE_DECIMAL,
        RFC_LARGE_EXPONENT,
        RFC_TRAILING_ZERO,
        RFC_SMALL_DECIMAL,
        RFC_SMALL_EXPONENT,
      ],
      string: '€$\u000f\nA\'B"\\"/',
      literals: [null, true, false],
    };

    expect(canonicalizeJson(value)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\"/"}',
    );
  });

  it("orders member names by UTF-16 code units and preserves array order", () => {
    const value = {
      "€": "euro",
      "\r": "carriage return",
      דּ: "hebrew",
      "1": "one",
      "😀": "emoji",
      "\u0080": "control",
      ö: "latin",
      array: ["z", "a"],
    };

    expect(canonicalizeJson(value)).toBe(
      '{"\\r":"carriage return","1":"one","array":["z","a"],"":"control","ö":"latin","€":"euro","😀":"emoji","דּ":"hebrew"}',
    );
  });

  it("uses ECMAScript number spelling including canonical negative zero", () => {
    expect(canonicalizeJson({ negativeZero: -0 })).toBe('{"negativeZero":0}');
  });
});

describe("canonical JSON UTF-8 boundaries", () => {
  it("encodes exact UTF-8 without BOM or a line feed", () => {
    const bytes = encodeCanonicalJson({ text: "ä😀" });

    expect(new TextDecoder().decode(bytes)).toBe('{"text":"ä😀"}');
    expect(bytes[0]).toBe("{".charCodeAt(0));
    expect(bytes.at(LAST_INDEX)).toBe("}".charCodeAt(0));
  });

  it("appends exactly one sidecar line feed", () => {
    const bytes = encodeCanonicalSidecarJson({ text: "line\n" });
    const decoded = new TextDecoder().decode(bytes);

    expect(decoded).toBe('{"text":"line\\n"}\n');
    expect(decoded.endsWith("\n\n")).toBe(false);
  });
});

describe("canonical JSON rejection", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite number %s",
    (value) => {
      expect(() => canonicalizeJson(value)).toThrow(TypeError);
    },
  );

  it.each([
    undefined,
    UNSUPPORTED_BIGINT,
    Symbol("value"),
    (): void => undefined,
  ])("rejects unsupported value %s", (value) => {
    expect(() => canonicalizeJson(value)).toThrow(TypeError);
  });

  it("rejects unsupported nested values instead of omitting or replacing them", () => {
    expect(() => canonicalizeJson({ omitted: undefined })).toThrow(TypeError);
    expect(() => canonicalizeJson([undefined])).toThrow(TypeError);
  });

  it("rejects cycles but permits repeated acyclic references", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow(/cyclic/u);

    const shared = { value: true };
    expect(canonicalizeJson([shared, shared])).toBe(
      '[{"value":true},{"value":true}]',
    );
  });

  it("rejects malformed arrays and non-data properties", () => {
    const sparse = new Array<unknown>(1);
    const withExtra = [true] as boolean[] & { extra?: boolean };
    withExtra.extra = true;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: (): boolean => true,
    });
    const hidden = Object.defineProperty({}, "value", {
      enumerable: false,
      value: true,
    });
    class DerivedArray extends Array<boolean> {}

    expect(() => canonicalizeJson(sparse)).toThrow(/dense/u);
    expect(() => canonicalizeJson(withExtra)).toThrow(/extra/u);
    expect(() => canonicalizeJson(new DerivedArray(true))).toThrow(
      /plain data arrays/u,
    );
    expect(() => canonicalizeJson(accessor)).toThrow(/data properties/u);
    expect(() => canonicalizeJson(hidden)).toThrow(/data properties/u);
    expect(() => canonicalizeJson(new Date(0))).toThrow(/plain data/u);
  });

  it("rejects symbols and unpaired UTF-16 surrogates in names and values", () => {
    const symbolRecord = { value: true, [Symbol("hidden")]: false };
    expect(() => canonicalizeJson(symbolRecord)).toThrow(/symbol/u);
    expect(() => canonicalizeJson("\ud800")).toThrow(/Unicode/u);
    expect(() => canonicalizeJson("\udc00")).toThrow(/Unicode/u);
    expect(() => canonicalizeJson({ "\ud800": true })).toThrow(/Unicode/u);
  });

  it("accepts nesting at the sidecar limit and rejects immediately above it", () => {
    expect(() => canonicalizeJson(nestedArrays(MAX_NESTING))).not.toThrow();
    expect(() => canonicalizeJson(nestedArrays(ABOVE_MAX_NESTING))).toThrow(
      RangeError,
    );
  });
});

function nestedArrays(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}
