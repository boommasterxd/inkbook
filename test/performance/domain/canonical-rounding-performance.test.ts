import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalizeGeometryNumber,
  isCanonicalUnitIntervalNumber,
} from "../../../src/domain/schema/canonical";

describe("canonical coordinate rounding", () => {
  it("avoids decimal string conversion for ordinary canonical coordinates", () => {
    const decimalFormatting = vi.spyOn(Number.prototype, "toFixed");
    try {
      for (const value of [-1234.125, -1.234, 0, 0.001, 1234.125, 1999.781]) {
        expect(canonicalizeGeometryNumber(value)).toBe(value);
      }
      expect(decimalFormatting).not.toHaveBeenCalled();
      expect(canonicalizeGeometryNumber(2_000_001.125)).toBe(2_000_001.125);
      expect(decimalFormatting).toHaveBeenCalledExactlyOnceWith(3);
    } finally {
      decimalFormatting.mockRestore();
    }
  });

  it("validates a maximum stroke's canonical pressure without decimal string conversion", () => {
    const pressures = Array.from(
      { length: MAX_STROKE_POINTS },
      (_, index) => (index % 10_001) / 10_000,
    );
    const decimalFormatting = vi.spyOn(Number.prototype, "toFixed");
    try {
      expect(pressures.every(isCanonicalUnitIntervalNumber)).toBe(true);
      expect(decimalFormatting.mock.calls.length).toBe(0);
    } finally {
      decimalFormatting.mockRestore();
    }
  });

  it.each([0.53, 1, 2.5])(
    "preserves canonical precision for a maximum stroke at scale %s",
    (scale) => {
      const coordinates = Array.from(
        { length: MAX_STROKE_POINTS * 2 },
        (_, index) => index * 0.731 - 1999.781,
      );
      const rounded = coordinates.map((value) => canonicalizeGeometryNumber(value * scale));
      expect(rounded).toHaveLength(MAX_STROKE_POINTS * 2);
      let failure: {
        index: number;
        source: number;
        value: number;
        canonical: number;
        error: number;
        finite: boolean;
        negativeZero: boolean;
      } | null = null;
      for (const [index, value] of rounded.entries()) {
        const source = coordinates[index]! * scale;
        const error = Math.abs(value - source);
        const canonical = canonicalizeGeometryNumber(value);
        const finite = Number.isFinite(value);
        const negativeZero = Object.is(value, -0);
        if (!finite || !(error <= 0.000500001) || !Object.is(canonical, value) || negativeZero)
          failure ??= { index, source, value, canonical, error, finite, negativeZero };
      }
      expect(failure).toBeNull();
    },
  );
});
