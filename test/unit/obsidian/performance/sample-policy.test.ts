import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { measurementRuns, statisticalSamples } from "../../../performance/sample-policy";

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

describe("paired measurement run policy", () => {
  it.each([1, 5, 20])("preserves %s full contract and reference runs", (count) => {
    for (const mode of ["contracts", "reference"]) {
      vi.stubEnv("INKBOOK_PERFORMANCE_MODE", mode);
      expect(measurementRuns(count)).toBe(count);
    }
  });

  it("uses one complete action population per paired measurement", () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "measurement");
    expect(measurementRuns(5)).toBe(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid run count %s",
    (count) => {
      expect(() => measurementRuns(count)).toThrow(TypeError);
    },
  );

  it("rejects an invalid performance mode", () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "invalid");
    expect(() => measurementRuns(5)).toThrow(TypeError);
  });
});
