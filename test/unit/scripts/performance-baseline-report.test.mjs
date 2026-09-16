import { describe, expect, it } from "vitest";
import {
  baselineContractPopulation,
  createBaselineReport,
  isStrictImprovement,
} from "../../../scripts/performance-baseline-report.mjs";
import { TIMING_PERFORMANCE_FILES } from "../../../scripts/performance-test-manifest.mjs";
import { validateBaselineReports } from "../../../scripts/performance-baseline-validation.mjs";

const context = { suite: "shared", runId: "123", runAttempt: "1" };

function fixture(suite = "shared") {
  const population = baselineContractPopulation(suite);
  const timing = population.filter(({ file }) => TIMING_PERFORMANCE_FILES.includes(file));
  return {
    metadata: {
      harnessCommit: "a".repeat(40),
      testedTree: "b".repeat(40),
      anchorCommit: "c".repeat(40),
      baseCommit: "d".repeat(40),
      candidateSourceHash: "e".repeat(64),
      anchorSourceHash: "f".repeat(64),
      harnessHash: "a".repeat(64),
      lockSha256: "b".repeat(64),
      dirty: false,
    },
    violations: [],
    batches: population.map(({ file, refreshRate }) => ({
      mode: "contracts",
      variant: "candidate",
      files: [file],
      refreshRate,
      violations: [],
      measurements: TIMING_PERFORMANCE_FILES.includes(file)
        ? [{ file, refreshRate, testName: "operation p99", ordinal: 1 }]
        : [],
    })),
    comparisons: [
      { variant: "base", status: "pass" },
      {
        variant: "anchor",
        status: "pass",
        metrics: [
          {
            key: JSON.stringify([timing[0].file, "operation p99", 1, timing[0].refreshRate]),
            ratios: Array(6).fill(0.9),
          },
        ],
        identicalInputs: timing.slice(1).map((entry) => ({ ...entry, inputHash: "c".repeat(64) })),
      },
    ],
  };
}

function addMetric(report, ratio) {
  const key = JSON.parse(report.comparisons[1].metrics[0].key);
  key[2] = 2;
  report.comparisons[1].metrics.push({ key: JSON.stringify(key), ratios: Array(6).fill(ratio) });
  const batch = report.batches.find(({ measurements }) => measurements.length > 0);
  batch.measurements.push({ ...batch.measurements[0], ordinal: 2 });
}

describe("strict promotion evidence", () => {
  it("round-trips generated shard reports through privileged validation", () => {
    const reports = ["shared", "cadence"].map((suite) =>
      createBaselineReport(fixture(suite), { ...context, suite }),
    );
    expect(validateBaselineReports(JSON.parse(JSON.stringify(reports)), reports[0])).toEqual({
      improvedMetrics: 2,
      sourceHash: "e".repeat(64),
    });
  });

  it("protects the complete shared and cadence populations without requesting more runs", () => {
    for (const suite of ["shared", "cadence"]) {
      const report = createBaselineReport(fixture(suite), { ...context, suite });
      expect(report.eligible).toBe(true);
      expect(report.improvedMetrics).toBe(1);
      expect(report.contractPopulation).toHaveLength(suite === "shared" ? 43 : 55);
      expect(report.metrics[0].ratios).toHaveLength(6);
    }
    expect(baselineContractPopulation("profile")).toEqual([]);
  });

  it.each([1.01, 1.49, 0, null, NaN, Infinity, -1])(
    "does not promote a passing regression gate with uncertain/slower ratio %s",
    (ratio) => {
      const report = fixture();
      report.comparisons[1].metrics[0].ratios[5] = ratio;
      expect(createBaselineReport(report, context).eligible).toBe(false);
    },
  );

  it("does not average away a slowdown in another metric", () => {
    const report = fixture();
    addMetric(report, 1.01);
    const handoff = createBaselineReport(report, context);
    expect(handoff.improvedMetrics).toBe(1);
    expect(handoff.eligible).toBe(false);
  });

  it("allows tied metrics alongside an improvement but never counts ties as improvement", () => {
    const report = fixture();
    addMetric(report, 1);
    const handoff = createBaselineReport(report, context);
    expect(handoff.eligible).toBe(true);
    expect(handoff.improvedMetrics).toBe(1);
    expect(handoff.metrics[1].status).toBe("non-regressing");
    report.comparisons[1].metrics[0].ratios[0] = 1;
    expect(createBaselineReport(report, context).improvedMetrics).toBe(0);
  });

  it("does not choose a later favorable stage after an unfavorable first six", () => {
    expect(isStrictImprovement([1.1, ...Array(17).fill(0.8)])).toBe(false);
    expect(isStrictImprovement([...Array(6).fill(0.8), ...Array(12).fill(1.1)])).toBe(true);
    expect(isStrictImprovement(Array(5).fill(0.8))).toBe(false);
    expect(isStrictImprovement(undefined)).toBe(false);
  });

  it("allows unchanged shards but reports no improvement", () => {
    const report = fixture();
    report.metadata.anchorSourceHash = report.metadata.candidateSourceHash;
    report.comparisons[1] = {
      variant: "anchor",
      status: "identical-source",
      sourceHash: report.metadata.candidateSourceHash,
    };
    const handoff = createBaselineReport(report, context);
    expect(handoff.eligible).toBe(true);
    expect(handoff.improvedMetrics).toBe(0);
    expect(handoff.identicalSource).toBe(true);
  });
});

describe("incomplete baseline evidence", () => {
  it.each([
    (r) => {
      r.metadata.dirty = true;
    },
    (r) => {
      r.metadata.testedTree = "missing";
    },
    (r) => {
      r.violations.push({ message: "failure" });
    },
    (r) => {
      r.error = "failed batch";
    },
    (r) => {
      r.batches.pop();
    },
    (r) => {
      r.batches.push(r.batches[0]);
    },
    (r) => {
      r.batches[0].violations.push({ message: "failure" });
    },
    (r) => {
      r.comparisons.pop();
    },
    (r) => {
      r.comparisons[0].status = "inconclusive";
    },
    (r) => {
      r.comparisons[1].identicalInputs.pop();
    },
    (r) => {
      r.comparisons[1].identicalInputs[0].inputHash = "missing";
    },
    (r) => {
      r.comparisons[1].metrics = [];
    },
    (r) => {
      r.comparisons[1].metrics[0].key = "invalid JSON";
    },
    (r) => {
      r.comparisons[1].metrics.push(r.comparisons[1].metrics[0]);
    },
  ])("fails closed for missing, failed, dirty, or duplicate evidence", (mutate) => {
    const report = fixture();
    mutate(report);
    expect(createBaselineReport(report, context).eligible).toBe(false);
  });

  it("requires a hosted run identity", () => {
    expect(createBaselineReport(fixture(), { ...context, runId: undefined }).eligible).toBe(false);
    expect(createBaselineReport(fixture(), { ...context, runAttempt: "0" }).eligible).toBe(false);
  });

  it("rejects an omitted individual metric even when its file still has measurements", () => {
    const report = fixture();
    const batch = report.batches.find(({ measurements }) => measurements.length > 0);
    batch.measurements.push({ ...batch.measurements[0], ordinal: 2 });
    expect(createBaselineReport(report, context).eligible).toBe(false);
  });
});
