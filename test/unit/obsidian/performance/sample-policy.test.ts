import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { statisticalSamples } from "../../../performance/sample-policy";

beforeEach(() => {
  vi.stubEnv("INKBOOK_PERFORMANCE_PROFILE", undefined);
  vi.stubEnv("INKBOOK_PERFORMANCE_MODE", undefined);
  vi.stubEnv("INKBOOK_PERFORMANCE_REPORT", "1");
});

afterEach(() => vi.unstubAllEnvs());

describe("statistical performance sample policy", () => {
  it.each([5, 20, 100])("retains all %s reference samples", (count) => {
    for (const mode of ["reference", "measurement"]) {
      vi.stubEnv("INKBOOK_PERFORMANCE_MODE", mode);
      expect(statisticalSamples(count)).toBe(count);
    }
  });

  it.each([5, 20, 100])(
    "executes one contract sample instead of %s timing repetitions",
    (count) => {
      vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "contracts");
      expect(statisticalSamples(count)).toBe(1);
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid count %s",
    (count) => {
      expect(() => statisticalSamples(count)).toThrow(TypeError);
    },
  );
});
