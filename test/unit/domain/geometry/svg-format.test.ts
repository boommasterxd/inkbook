import { describe, expect, it } from "vitest";

import { roundCanonical } from "../../../../src/domain/geometry/public";
import {
  arcTo,
  cubicTo,
  lineTo,
  moveTo,
  quadraticTo,
} from "../../../../src/domain/geometry/svg-format";

describe("SVG number formatting", () => {
  it("preserves all command contracts and separator rules", () => {
    expect(moveTo({ x: 1.2344, y: -0 })).toBe("M1.234 0");
    expect(lineTo({ x: -1.2344, y: 2 })).toBe("L-1.234 2");
    expect(quadraticTo({ x: 1, y: -2 }, { x: 3, y: -4 })).toBe("Q1-2 3-4");
    expect(cubicTo({ x: 1, y: 2 }, { x: -3, y: 4 }, { x: 5, y: -6 })).toBe("C1 2-3 4 5-6");
    expect(arcTo(2.3454, 1, { x: -3, y: 4 })).toBe("A2.345 2.345 0 0 1-3 4");
  });

  it.each([
    -2_000_001,
    -2_000_000,
    -1.2345,
    -0.0005,
    -0,
    0,
    0.0005,
    1.2345,
    999_999.9995,
    1_000_000,
    2_000_000,
    2_000_001,
    1e21,
    Number.MAX_VALUE,
  ])("matches canonical reference formatting for boundary value %s", (value) => {
    expect(moveTo({ x: value, y: value })).toBe(referenceMove(value, value));
  });

  it("matches the canonical reference across a large deterministic value set", () => {
    let state = 0x9e3779b9;
    for (let index = 0; index < 250_000; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const integral = (state % 4_000_001) - 2_000_000;
      const fraction = ((state >>> 8) % 10_000) / 10_000;
      const value = index % 2 === 0 ? integral + fraction : integral - fraction;
      expect(moveTo({ x: value, y: -value })).toBe(referenceMove(value, -value));
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite value %s",
    (value) => {
      expect(() => moveTo({ x: value, y: 0 })).toThrow(RangeError);
      expect(() => moveTo({ x: 0, y: value })).toThrow(RangeError);
    },
  );
});

function referenceMove(x: number, y: number): string {
  return `M${referenceNumber(x)}${referenceNumber(y).startsWith("-") ? "" : " "}${referenceNumber(y)}`;
}

function referenceNumber(value: number): string {
  return String(roundCanonical(value));
}
