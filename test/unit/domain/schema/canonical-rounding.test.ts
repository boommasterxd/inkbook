import { describe, expect, it } from "vitest";

import {
  canonicalizeGeometryNumber,
  canonicalizeRotation,
  canonicalizeUnitIntervalNumber,
  isCanonicalGeometryNumber,
} from "../../../../src/domain/schema/canonical";

function reference(value: number, decimals = 3): number {
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function adjacent(value: number, direction: -1 | 1): number {
  if (value === 0) return direction * Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const step = BigInt(value > 0 ? direction : -direction);
  view.setBigUint64(0, view.getBigUint64(0) + step);
  return view.getFloat64(0);
}

describe("canonical geometry rounding compatibility", () => {
  it("preserves decimal ties and their immediately adjacent binary values", () => {
    const magnitudes = [0, 1, 9, 100, 1000, 999_999, 1_000_000, 1_999_999, 2_000_000];
    for (const magnitude of magnitudes) {
      for (const fraction of [0, 1, 9, 10, 99, 100, 499, 500, 998, 999]) {
        for (const sign of [-1, 1]) {
          const tie = sign * (magnitude + (fraction + 0.5) / 1000);
          for (const value of [adjacent(tie, -1), tie, adjacent(tie, 1)]) {
            expect(canonicalizeGeometryNumber(value)).toBe(reference(value));
          }
        }
      }
    }
  });

  it.each([
    -Number.MAX_VALUE,
    -1e21,
    -2_000_001,
    -2_000_000,
    -Number.MIN_VALUE,
    -0,
    0,
    Number.MIN_VALUE,
    2_000_000,
    2_000_001,
    1e21,
    Number.MAX_VALUE,
  ])("preserves signed zero, tiny values, and fallback range at %s", (value) => {
    expect(canonicalizeGeometryNumber(value)).toBe(reference(value));
  });

  it("matches the previous contract for deterministic arithmetic and stored coordinates", () => {
    let state = 0x9e3779b9;
    let failure: { actual: number; expected: number; value: number } | null = null;
    for (let index = 0; index < 200_000; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const source = (state % 2_000_000_001) / 1000 - 1_000_000;
      const value = index % 2 === 0 ? source : source * 1.13241 + Math.sin(index) * 0.5;
      const expected = reference(value);
      const actual = canonicalizeGeometryNumber(value);
      if (!Object.is(actual, expected)) failure ??= { actual, expected, value };
    }
    expect(failure).toBeNull();
  });

  it("retains four-decimal pressure and rotation normalization contracts", () => {
    for (const value of [-540.0005, -180.0005, -0.0005, 0.0005, 179.9995, 540.0005]) {
      const normalized = ((((reference(value) + 180) % 360) + 360) % 360) - 180;
      expect(canonicalizeRotation(value)).toBe(reference(normalized));
    }
    for (const value of [0, 0.00005, 0.12345, 0.49995, 0.50005, 0.99995, 1]) {
      expect(canonicalizeUnitIntervalNumber(value)).toBe(reference(value, 4));
    }
  });

  it.each([Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY])(
    "still rejects non-finite input %s at the schema boundary",
    (value) => {
      expect(() => canonicalizeGeometryNumber(value)).toThrow("Geometry values must be finite.");
      expect(isCanonicalGeometryNumber(value)).toBe(false);
    },
  );
});
