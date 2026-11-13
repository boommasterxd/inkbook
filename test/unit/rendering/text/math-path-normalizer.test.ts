import { describe, expect, it } from "vitest";

import { normalizeMathPath } from "../../../../src/rendering/text/math-path-normalizer";
import {
  IDENTITY_MATH_MATRIX,
  mathTransformMatrix,
} from "../../../../src/rendering/text/math-path-transform";

describe("portable math path geometry", () => {
  it("bakes nested affine transforms and expands relative/smooth glyph commands", () => {
    const matrix = mathTransformMatrix("translate(10 20) scale(2 -2)");
    expect(normalizeMathPath("M1 2h3v4l1 1q1 2 3 4t2 3c1 2 3 4 5 6s2 3 4 5z", matrix)).toBe(
      "M12 16 L18 16 L18 8 L20 6 Q22 2 26 -2 Q30 -6 30 -8 C32 -12 36 -16 40 -20 C44 -24 44 -26 48 -30 Z",
    );
  });

  it("accepts implicit line coordinates, exponents and subpath closure", () => {
    expect(normalizeMathPath("M1e1,2 3,4Z m1 1 2 3", IDENTITY_MATH_MATRIX)).toBe(
      "M10 2 L3 4 Z M11 3 L13 6",
    );
  });

  it.each(["M0 0A1 1 0 0 0 2 2", "M0<script>", "M0 0C1 2", "M1e999 2"])(
    "rejects unsupported or malformed geometry %s",
    (source) => {
      expect(() => normalizeMathPath(source, IDENTITY_MATH_MATRIX)).toThrow();
    },
  );
});
