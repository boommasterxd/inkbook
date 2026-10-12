import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalizeGeometryNumber,
  isCanonicalUnitIntervalNumber,
} from "../../../src/domain/schema/canonical";

describe("canonical coordinate rounding", () => {
  it("validates every pressure sample without decimal formatting in the standard capacity", () => {
    const decimalFormatting = vi.spyOn(Number.prototype, "toFixed");
    let accepted = 0;
    try {
      for (let index = 0; index < 500_000; index += 1) {
        if (isCanonicalUnitIntervalNumber((index % 10_001) / 10_000)) accepted += 1;
      }
      expect(accepted).toBe(500_000);
      expect(decimalFormatting).not.toHaveBeenCalled();
    } finally {
      decimalFormatting.mockRestore();
    }
  });

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

  it.each([0.53, 1, 2.5])(
    "preserves canonical precision for a maximum stroke at scale %s",
    (scale) => {
      const coordinates = Array.from(
        { length: MAX_STROKE_POINTS * 2 },
        (_, index) => index * 0.731 - 1999.781,
      );
      const rounded = coordinates.map((value) => canonicalizeGeometryNumber(value * scale));
      expect(rounded).toHaveLength(MAX_STROKE_POINTS * 2);
      for (const [index, value] of rounded.entries()) {
        expect(Number.isFinite(value)).toBe(true);
        expect(Math.abs(value - coordinates[index]! * scale)).toBeLessThanOrEqual(0.000500001);
        expect(canonicalizeGeometryNumber(value)).toBe(value);
        expect(Object.is(value, -0)).toBe(false);
      }
    },
  );
});
