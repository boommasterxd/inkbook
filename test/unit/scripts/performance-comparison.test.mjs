import { describe, expect, it } from "vitest";

import { compareTimingRounds } from "../../../scripts/performance-comparison.mjs";

function rounds(values, overrides = {}) {
  return values.map((actualMs) => [
    {
      file: "test/performance/operation.test.ts",
      testName: "operation",
      ordinal: 1,
      refreshRate: 240,
      actualMs,
      referenceMs: 2,
      comparison: "lte",
      ...overrides,
    },
  ]);
}

describe("paired performance comparison", () => {
  it.each([
    [[100, 100, 100], [100, 100, 100], "pass"],
    [[100, 100, 100], [110, 110, 110], "pass"],
    [[100, 100, 100], [200, 200, 200], "regression"],
    [[100, 100, 100], [109, 110, 111], "inconclusive"],
    [[100, 121, 100], [100, 121, 100], "pass"],
    [[1, 2, 4], [1, 2, 4], "pass"],
    [[1, 2, 4], [0.8, 2, 4], "inconclusive"],
    [[1, 2, 4], [2, 4, 8], "regression"],
    [[100, 100, 100], [50, 60, 50], "pass"],
    [[100, 100, 100], [50, 61, 50], "inconclusive"],
    [[100, 100, 100], [80, 100, 100], "inconclusive"],
    [[100, 120, 100], [100, 120, 100], "pass"],
    [[100, 150, 100], [200, 300, 200], "regression"],
    [[0, 100, 100], [100, 100, 100], "inconclusive"],
    [[100, 100, 100], [0, 100, 100], "inconclusive"],
  ])("classifies reference %j and candidate %j as %s", (reference, candidate, status) => {
    expect(compareTimingRounds(rounds(reference), rounds(candidate)).status).toBe(status);
  });

  it("retains paired ratios and does not mutate inputs", () => {
    const reference = rounds([100, 110, 100]);
    const candidate = rounds([105, 110, 100]);
    const original = structuredClone([reference, candidate]);
    const result = compareTimingRounds(reference, candidate);
    expect(result.metrics[0]).toMatchObject({ ratios: [1.05, 1, 1], minRatio: 1, maxRatio: 1.05 });
    expect([reference, candidate]).toEqual(original);
  });

  it("never hides an individual regression behind faster or uncertain metrics", () => {
    const reference = rounds([100, 100, 100]);
    const candidate = rounds([200, 200, 200]);
    for (let index = 0; index < 3; index += 1) {
      reference[index].push(...rounds([100], { ordinal: 2 })[0]);
      candidate[index].push(...rounds([index === 0 ? 0 : 50], { ordinal: 2 })[0]);
      candidate[index].reverse();
    }
    const result = compareTimingRounds(reference, candidate);
    expect(result.status).toBe("regression");
    expect(result.metrics.map((metric) => metric.status)).toEqual(["regression", "inconclusive"]);
  });

  it.each([
    { actualMs: NaN },
    { actualMs: Infinity },
    { actualMs: -1 },
    { referenceMs: 0 },
    { referenceMs: Infinity },
    { comparison: "equal" },
    { file: "" },
    { testName: "" },
    { ordinal: 0 },
    { refreshRate: 61 },
  ])("rejects invalid measurement %j", (invalid) => {
    expect(() => compareTimingRounds(rounds([1, 1, 1]), rounds([1, 1, 1], invalid))).toThrow();
  });

  it.each([{ referenceMs: 3 }, { comparison: "lt" }, { testName: "different" }])(
    "rejects changed identity or contract %j",
    (change) => {
      const candidate = rounds([1, 1, 1]);
      Object.assign(candidate[1][0], change);
      expect(() => compareTimingRounds(rounds([1, 1, 1]), candidate)).toThrow();
    },
  );

  it("rejects missing, extra, duplicate and empty populations", () => {
    const reference = rounds([1, 1, 1]);
    for (const candidate of [[], rounds([1, 1]), [[], [], []]]) {
      expect(() => compareTimingRounds(reference, candidate)).toThrow();
    }
    const candidate = rounds([1, 1, 1]);
    candidate[1].push({ ...candidate[1][0], ordinal: 2 });
    expect(() => compareTimingRounds(reference, candidate)).toThrow();
    candidate[1][1].ordinal = 1;
    expect(() => compareTimingRounds(reference, candidate)).toThrow();
  });

  it("rejects overflowing ratios and inconsistent reference rounds", () => {
    expect(() =>
      compareTimingRounds(rounds([Number.MIN_VALUE, 1, 1]), rounds([1, 1, 1])),
    ).toThrow();
    const reference = rounds([1, 1, 1]);
    reference[2][0].referenceMs = 3;
    expect(() => compareTimingRounds(reference, rounds([1, 1, 1]))).toThrow();
  });
});
