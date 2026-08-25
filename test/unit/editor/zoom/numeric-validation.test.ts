import { describe, expect, it } from "vitest";

import {
  requireFinite,
  requireNonNegative,
  requirePositive,
} from "../../../../src/editor/zoom/numeric-validation";

describe("zoom numeric validation", () => {
  it("accepts finite values and preserves the original number", () => {
    expect(requireFinite(12.5, "value")).toBe(12.5);
    expect(requirePositive(0.25, "zoom")).toBe(0.25);
    expect(requireNonNegative(0, "height")).toBe(0);
  });

  it("rejects non-finite values with the supplied field name", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => requireFinite(value, "camera")).toThrow("camera must be finite");
      expect(() => requirePositive(value, "zoom")).toThrow("zoom must be finite");
      expect(() => requireNonNegative(value, "height")).toThrow("height must be finite");
    }
  });

  it("rejects zero and negative values according to each lower bound", () => {
    expect(() => requirePositive(0, "zoom")).toThrow("zoom must be positive");
    expect(() => requirePositive(-1, "zoom")).toThrow("zoom must be positive");
    expect(() => requireNonNegative(-0.001, "height")).toThrow("height must be non-negative");
  });
});
