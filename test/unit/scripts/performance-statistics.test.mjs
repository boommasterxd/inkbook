import { describe, expect, it } from "vitest";
import {
  extractComparisonStatistics,
  validateComparisonStatistics,
} from "../../../scripts/performance-statistics.mjs";
import { compareTimingRounds } from "../../../scripts/performance-comparison.mjs";

function result(
  samples,
  statistics = [{ kind: "p99", population: "samples", minimumSamples: 100 }],
) {
  return {
    statistics,
    blocks: [
      {
        measurements: [
          {
            side: "reference",
            samplesMs: samples,
            operationWorkMs: [samples.reduce((a, b) => a + b, 0)],
          },
        ],
      },
    ],
  };
}
function rounds(actualMs) {
  return Array.from({ length: 3 }, () => [
    {
      file: "kernel",
      testName: "phase",
      ordinal: 1,
      refreshRate: 240,
      actualMs,
      referenceMs: 1,
      comparison: "lte",
    },
  ]);
}

describe("original timing statistics from retained populations", () => {
  it("detects seven slow frames which the total-work metric amortizes away", () => {
    const reference = Array(600).fill(1);
    const candidate = [...Array(593).fill(1), ...Array(7).fill(4)];
    expect(compareTimingRounds(rounds(600), rounds(621)).status).toBe("pass");
    const baseline = extractComparisonStatistics(result(reference), "reference")[0].actualMs;
    const changed = extractComparisonStatistics(result(candidate), "reference")[0].actualMs;
    expect(baseline).toBe(1);
    expect(changed).toBe(4);
    expect(compareTimingRounds(rounds(baseline), rounds(changed)).status).toBe("regression");
  });
  it("uses exact nearest-rank percentiles and preserves max independently", () => {
    const value = result(
      Array.from({ length: 100 }, (_, i) => i + 1),
      [
        { kind: "p50", population: "samples" },
        { kind: "p95", population: "samples" },
        { kind: "p99", population: "samples" },
        { kind: "max", population: "samples" },
      ],
    );
    expect(extractComparisonStatistics(value, "reference").map(({ actualMs }) => actualMs)).toEqual(
      [50, 95, 99, 100],
    );
  });
  it("preserves the height helper's upper-rank quantile at exact integer ranks", () => {
    const value = result(
      Array.from({ length: 100 }, (_, index) => index + 1),
      [{ kind: "p99", population: "samples", estimator: "upper-rank" }],
    );
    expect(extractComparisonStatistics(value, "reference")[0].actualMs).toBe(100);
  });
  it.each([
    ["complete twenty-operation groups", [...Array(18).fill(1), 4, 4, ...Array(80).fill(1)], 4],
    ["a final partial window", [...Array(100).fill(1), 9], 9],
  ])("preserves %s which pooled p95 hides", (_name, samples, expected) => {
    const value = result(samples, [
      {
        kind: "p95",
        population: "operations",
        minimumSamples: 100,
        aggregation: "worst-window",
        windowSize: 20,
      },
    ]);
    value.blocks[0].measurements[0].operationWorkMs = samples;
    expect(extractComparisonStatistics(value, "reference")[0].actualMs).toBe(expected);
    value.statistics = [{ kind: "p95", population: "operations" }];
    expect(extractComparisonStatistics(value, "reference")[0].actualMs).toBe(1);
  });
  it("keeps raw intervals separate from complete-operation totals", () => {
    const value = result(
      [1, 9],
      [
        { kind: "max", population: "samples" },
        { kind: "total", population: "operations" },
      ],
    );
    expect(extractComparisonStatistics(value, "reference").map(({ actualMs }) => actualMs)).toEqual(
      [9, 10],
    );
    value.blocks[0].measurements[0].operationWorkMs.push(10);
    expect(extractComparisonStatistics(value, "reference")[1].actualMs).toBe(10);
  });
  it("rejects too few samples or complete operations", () => {
    expect(() => extractComparisonStatistics(result(Array(99).fill(1)), "reference")).toThrow(
      "Insufficient",
    );
    const value = result(Array(100).fill(1), [
      { kind: "p99", population: "samples", minimumOperations: 2 },
    ]);
    expect(() => extractComparisonStatistics(value, "reference")).toThrow("complete operations");
  });
  it("only applies an explicitly declared original percentile fallback", () => {
    const statistics = [
      { kind: "p99", population: "samples", minimumSamples: 100, fallback: "max" },
    ];
    expect(extractComparisonStatistics(result([1, 5], statistics), "reference")).toEqual([
      { key: "samples:p99", actualMs: 5 },
    ]);
  });
});

describe("invalid timing statistic populations", () => {
  it.each([
    undefined,
    [],
    [{ kind: "p99", population: "batches" }],
    [
      { kind: "max", population: "samples" },
      { kind: "max", population: "samples" },
    ],
    [{ kind: "p99", population: "samples", minimumSamples: 0 }],
    [{ kind: "total", population: "samples" }],
  ])("fails closed on missing or invalid statistic metadata", (statistics) => {
    expect(() => validateComparisonStatistics(statistics)).toThrow();
  });
  it.each([[NaN], [Infinity], [-1], []])("rejects invalid retained intervals", (samples) => {
    expect(() => extractComparisonStatistics(result(samples), "reference")).toThrow();
  });
  it("does not silently use the other variant when a population is missing", () => {
    expect(() => extractComparisonStatistics(result([1]), "candidate")).toThrow("Missing paired");
  });
});
