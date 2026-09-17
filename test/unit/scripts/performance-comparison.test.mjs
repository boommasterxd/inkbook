import { describe, expect, it } from "vitest";

import { compareTimingRounds, REGRESSION_RATIO } from "../../../scripts/performance-comparison.mjs";

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

function compareRatios(values, overrides = {}) {
  return compareTimingRounds(
    rounds(
      values.map(() => 1),
      overrides,
    ),
    rounds(values, overrides),
  );
}

const six = (value) => Array(6).fill(value);
const latePass = [...six(1.2), ...Array(12).fill(1)];

describe("paired performance comparison", () => {
  it.each([
    [six(1), "pass"],
    [six(1.199), "pass"],
    [six(1.2), "inconclusive"],
    [six(1.201), "regression"],
    [[1, 1, 1, 1, 1, 2], "inconclusive"],
    [[2, 2, 2, 2, 2, 1], "inconclusive"],
    [[0, 1, 1, 1, 1, 1], "inconclusive"],
    [latePass, "inconclusive"],
  ])("classifies paired ratios %j as %s", (values, status) => {
    expect(compareRatios(values).status).toBe(status);
  });

  it.each([
    [13, 1, 2, "inconclusive"],
    [14, 1, 2, "pass"],
    [13, 2, 1, "inconclusive"],
    [14, 2, 1, "regression"],
  ])("requires fourteen strict signs at eighteen: %j", (count, majority, minority, status) => {
    const values = [minority, ...Array(count).fill(majority), ...Array(17 - count).fill(minority)];
    const result = compareRatios(values);
    expect(result.status).toBe(status);
    expect(result.metrics[0]).toMatchObject({ stage: 18, requiredSigns: 14 });
  });

  it.each([
    [1, 2, "pass"],
    [2, 1, "regression"],
  ])("freezes a six-pair decision despite later opposing evidence", (first, later, status) => {
    const values = [...six(first), ...Array(12).fill(later)];
    const metric = compareRatios(values).metrics[0];
    expect(metric).toMatchObject({ status, stage: 6, requiredSigns: 6, ratios: values });
    expect(metric.lowerMedianBound).toBe(first);
    expect(metric.upperMedianBound).toBe(first);
  });

  it("retains all raw ratios without using later zero values to reopen a decision", () => {
    const metric = compareRatios([...six(1), ...Array(12).fill(0)]).metrics[0];
    expect(metric.status).toBe("pass");
    expect(metric.stage).toBe(6);
    expect(metric.ratios).toEqual([...six(1), ...Array(12).fill(null)]);
  });

  it("keeps zero observations inconclusive rather than dropping them", () => {
    const values = [0, ...Array(17).fill(1)];
    expect(compareRatios(values).metrics[0]).toMatchObject({
      status: "inconclusive",
      stage: 18,
      belowCount: 17,
      lowerMedianBound: null,
      upperMedianBound: null,
    });
    expect(compareTimingRounds(rounds([0, ...six(1).slice(1)]), rounds(six(1))).status).toBe(
      "inconclusive",
    );
  });

  it("reports stage-specific signs and median bounds without mutating inputs", () => {
    const values = [2, ...Array(14).fill(1), 2, 2, 2];
    const reference = rounds(Array(18).fill(1));
    const candidate = rounds(values);
    const original = structuredClone([reference, candidate]);
    expect(compareTimingRounds(reference, candidate).metrics[0]).toMatchObject({
      ratios: values,
      minRatio: 1,
      maxRatio: 2,
      stage: 18,
      requiredSigns: 14,
      belowCount: 14,
      aboveCount: 4,
      lowerMedianBound: 1,
      upperMedianBound: 1,
    });
    expect([reference, candidate]).toEqual(original);
  });
});

describe("paired performance evidence validation", () => {
  it("never hides an individual regression behind faster or uncertain metrics", () => {
    const reference = rounds(six(100));
    const candidate = rounds(six(200));
    for (let index = 0; index < 6; index += 1) {
      reference[index].push(...rounds([100], { ordinal: 2 })[0]);
      candidate[index].push(...rounds([index === 0 ? 0 : 50], { ordinal: 2 })[0]);
      candidate[index].reverse();
    }
    const result = compareTimingRounds(reference, candidate);
    expect(result.status).toBe("regression");
    expect(result.metrics.map((metric) => metric.status)).toEqual(["regression", "inconclusive"]);
  });

  it.each([
    { statistic: undefined },
    { statistic: "median" },
    { statistic: null },
    { statistic: "p99" },
    { statistic: "mean" },
    { statistic: 1.1 },
    { statistic: {} },
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
    expect(() => compareTimingRounds(rounds(six(1)), rounds(six(1), invalid))).toThrow();
  });

  it.each([
    { referenceMs: 3 },
    { comparison: "lt" },
    { testName: "different" },
    { statistic: "median" },
  ])("validates later contracts even after an early decision: %j", (change) => {
    const candidate = rounds(Array(18).fill(1));
    Object.assign(candidate[17][0], change);
    expect(() => compareTimingRounds(rounds(Array(18).fill(1)), candidate)).toThrow();
  });

  it("rejects missing, unequal, extra, duplicate and empty populations", () => {
    const reference = rounds(six(1));
    for (const candidate of [
      null,
      [],
      rounds([1, 1, 1]),
      rounds(Array(18).fill(1)),
      Array(6).fill([]),
    ]) {
      expect(() => compareTimingRounds(reference, candidate)).toThrow();
    }
    const candidate = rounds(six(1));
    candidate[1].push({ ...candidate[1][0], ordinal: 2 });
    expect(() => compareTimingRounds(reference, candidate)).toThrow();
    candidate[1][1].ordinal = 1;
    expect(() => compareTimingRounds(reference, candidate)).toThrow();
  });

  it("rejects overflowing ratios and inconsistent reference rounds", () => {
    expect(() => compareTimingRounds(rounds(six(Number.MIN_VALUE)), rounds(six(1)))).toThrow();
    expect(
      compareTimingRounds(rounds(six(Number.MAX_VALUE)), rounds(six(Number.MAX_VALUE))).status,
    ).toBe("pass");
    const reference = rounds(six(1));
    reference[2][0].referenceMs = 3;
    expect(() => compareTimingRounds(reference, rounds(six(1)))).toThrow();
  });
});

describe("timing regression policies", () => {
  it.each([
    { testName: "operation p99" },
    { testName: "single elapsed operation" },
    { testName: "maximum frame duration" },
    { testName: "operation median" },
  ])("uses the same threshold regardless of the metric name: %j", (metadata) => {
    for (const [ratio, status] of [
      [1.1, "pass"],
      [1.199, "pass"],
      [1.2, "inconclusive"],
      [1.201, "regression"],
    ]) {
      expect(compareRatios(six(ratio), metadata).metrics[0]).toMatchObject({
        status,
        regressionRatio: 1.2,
      });
    }
    expect(REGRESSION_RATIO).toBe(1.2);
    for (const [base, candidate, budget, status] of [
      [0.01, 0.011, 2, "pass"],
      [0.01, 0.012, 2, "inconclusive"],
      [0.01, 0.02, 2, "regression"],
      [0.01, 0.02, 0.25, "regression"],
      [0.01, 0.011, 0.25, "pass"],
      [0, 0.001, 2, "inconclusive"],
      [0.001, 0, 2, "inconclusive"],
    ]) {
      const contract = { ...metadata, referenceMs: budget };
      const result = compareTimingRounds(
        rounds(six(base), contract),
        rounds(six(candidate), contract),
      );
      expect(result.metrics[0]).toMatchObject({ status, regressionRatio: 1.2 });
    }
    const mixed = compareTimingRounds(
      rounds([0.01, 1, 0.01, 1, 0.01, 1], metadata),
      rounds([0.09, 1.1, 0.09, 1.1, 0.09, 1.1], metadata),
    );
    expect(mixed.status).toBe("inconclusive");
  });

  it("ignores caller-supplied thresholds", () => {
    expect(compareRatios(six(1.3), { regressionRatio: 2 }).metrics[0]).toMatchObject({
      status: "regression",
      regressionRatio: 1.2,
    });
    const contract = { minimumIncreaseMs: 100 };
    expect(
      compareTimingRounds(rounds(six(0.01), contract), rounds(six(0.2), contract)).status,
    ).toBe("regression");
  });

  it.each([0, 1])("rejects obsolete median evidence on side %s", (side) => {
    const paired = [rounds(six(1)), rounds(six(1))];
    paired[side][0][0].statistic = "median";
    expect(() => compareTimingRounds(...paired)).toThrow("Invalid performance comparison");
  });
});

describe("relative-only comparisons", () => {
  const relative = {
    referenceMs: null,
    limitMs: null,
    ratio: null,
    comparison: "relative",
    label: "total work",
  };

  it.each([
    [1, "pass"],
    [1.2, "inconclusive"],
    [1.6, "regression"],
    [0, "inconclusive"],
  ])(
    "compares relative work %s with the shared ratio and no reference-device budget",
    (ratio, status) => {
      expect(compareRatios(six(ratio), relative).metrics[0]).toMatchObject({
        status,
        regressionRatio: 1.2,
      });
      expect(
        compareTimingRounds(rounds(six(0.01), relative), rounds(six(0.02), relative)).status,
      ).toBe("regression");
      expect(
        compareTimingRounds(rounds(six(0.01), relative), rounds(six(0.2), relative)).status,
      ).toBe("regression");
    },
  );

  it("keeps relative regression visible alongside a passing absolute metric", () => {
    const reference = rounds(six(1));
    const candidate = rounds(six(1));
    for (let index = 0; index < 6; index += 1) {
      reference[index].push(...rounds([1], { ...relative, ordinal: 2 })[0]);
      candidate[index].push(...rounds([1.6], { ...relative, ordinal: 2 })[0]);
    }
    const result = compareTimingRounds(...JSON.parse(JSON.stringify([reference, candidate])));
    expect(result.status).toBe("regression");
    expect(result.metrics.map(({ status }) => status)).toEqual(["pass", "regression"]);
  });

  it.each([
    { referenceMs: 1 },
    { referenceMs: undefined },
    { limitMs: 1 },
    { limitMs: undefined },
    { ratio: 1 },
    { ratio: undefined },
    { label: "" },
    { label: null },
    { comparison: "lte" },
  ])("rejects mixed relative evidence %j", (override) => {
    expect(() => compareRatios(six(1), { ...relative, ...override })).toThrow();
  });

  it.each([{ referenceMs: null }, { limitMs: null }, { ratio: null }])(
    "does not permit null absolute contract fields %j",
    (override) => {
      expect(() => compareRatios(six(1), override)).toThrow();
    },
  );

  it("rejects drift from a relative metric to an absolute metric or another label", () => {
    const reference = rounds(Array(18).fill(1), relative);
    for (const changed of [
      { label: "different work" },
      { comparison: "lte", referenceMs: 2, limitMs: 2, ratio: 0.5 },
    ]) {
      const candidate = rounds(Array(18).fill(1), relative);
      Object.assign(candidate[17][0], changed);
      expect(() => compareTimingRounds(reference, candidate)).toThrow("contract differs");
    }
  });
});
