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

function compareRatios(values) {
  return compareTimingRounds(rounds(values.map(() => 1)), rounds(values));
}

const six = (value) => Array(6).fill(value);
const latePass = [...six(1.5), ...Array(12).fill(1)];

describe("paired performance comparison", () => {
  it.each([
    [six(1), "pass"],
    [six(1.499), "pass"],
    [six(1.5), "inconclusive"],
    [six(1.501), "regression"],
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

  it.each([{ referenceMs: 3 }, { comparison: "lt" }, { testName: "different" }])(
    "validates later contracts even after an early decision: %j",
    (change) => {
      const candidate = rounds(Array(18).fill(1));
      Object.assign(candidate[17][0], change);
      expect(() => compareTimingRounds(rounds(Array(18).fill(1)), candidate)).toThrow();
    },
  );

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
    const reference = rounds(six(1));
    reference[2][0].referenceMs = 3;
    expect(() => compareTimingRounds(reference, rounds(six(1)))).toThrow();
  });
});
