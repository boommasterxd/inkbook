import { describe, expect, it } from "vitest";

import { baselineContractPopulation } from "../../../scripts/performance-baseline-report.mjs";
import { TIMING_PERFORMANCE_FILES } from "../../../scripts/performance-test-manifest.mjs";
import {
  validateBaselineReports,
  validateJobs,
  validateWorkflowRun,
} from "../../../scripts/performance-baseline-validation.mjs";

const context = {
  testedCommit: "a".repeat(40),
  testedTree: "b".repeat(40),
  anchorCommit: "c".repeat(40),
  baseCommit: "d".repeat(40),
  runId: "42",
  runAttempt: "1",
};
function reports() {
  return ["shared", "cadence"].map((suite) => {
    const contractPopulation = baselineContractPopulation(suite);
    const identicalInputs = contractPopulation
      .filter(({ file }) => TIMING_PERFORMANCE_FILES.includes(file))
      .map((item) => ({ ...item, inputHash: "f".repeat(64) }));
    const metrics = [];
    if (suite === "shared") {
      const { file, refreshRate } = identicalInputs.shift();
      metrics.push({
        key: JSON.stringify([file, "measured", 1, refreshRate]),
        ratios: Array(6).fill(0.9),
        status: "improved",
      });
    }
    return {
      ...context,
      version: 1,
      suite,
      eligible: true,
      dirty: false,
      sourceHash: "e".repeat(64),
      anchorSourceHash: "f".repeat(64),
      harnessHash: "f".repeat(64),
      lockSha256: "f".repeat(64),
      improvedMetrics: metrics.length,
      metrics,
      timingMetricKeys: metrics.map(({ key }) => key),
      contractPopulation,
      identicalSource: false,
      identicalInputs,
    };
  });
}

describe("baseline promotion evidence", () => {
  it("accepts measured improvements plus complete unchanged-input evidence", () => {
    expect(validateBaselineReports(reports(), context).improvedMetrics).toBe(1);
  });
  it.each([1, 1.001, 0, -1, Infinity, NaN, "0.9"])(
    "rejects a non-improvement ratio %s",
    (ratio) => {
      const values = reports();
      values[0].metrics[0].ratios[5] = ratio;
      expect(() => validateBaselineReports(values, context)).toThrow();
    },
  );
  it.each(["testedCommit", "testedTree", "anchorCommit", "baseCommit", "runId", "runAttempt"])(
    "rejects stale or unrelated %s",
    (field) => {
      const values = reports();
      values[0][field] = field.startsWith("run") ? "43" : "0".repeat(40);
      expect(() => validateBaselineReports(values, context)).toThrow();
    },
  );
  it.each([
    (values) => values.pop(),
    (values) => {
      values[1] = values[0];
    },
    (values) => {
      values[0].eligible = false;
    },
    (values) => {
      values[0].dirty = true;
    },
    (values) => {
      values[0].improvedMetrics = 3;
    },
    (values) => {
      values[0].metrics[0].ratios.pop();
    },
    (values) => {
      values[0].metrics[0].status = "inconclusive";
    },
    (values) => {
      values[0].metrics.push(values[0].metrics[0]);
    },
    (values) => {
      values[0].contractPopulation.pop();
    },
    (values) => {
      values[0].identicalInputs.pop();
    },
    (values) => {
      values[0].identicalInputs[0].inputHash = "bad";
    },
    (values) => {
      values[0].identicalInputs.push(values[0].identicalInputs[0]);
    },
    (values) => {
      values[0].metrics[0].key = "invalid-json";
    },
    (values) => {
      values[0].metrics[0].key = JSON.stringify(["unknown", "test", 1, 120]);
    },
    (values) => {
      values[0].metrics[0].key = JSON.stringify(["unknown", "test", 0, 120]);
    },
    (values) => {
      values[1].harnessHash = "0".repeat(64);
    },
    (values) => {
      values[1].sourceHash = "0".repeat(64);
    },
    (values) => {
      values[1].lockSha256 = "0".repeat(64);
    },
  ])("rejects incomplete, contradictory or fabricated eligibility", (mutate) => {
    const values = reports();
    mutate(values);
    expect(() => validateBaselineReports(values, context)).toThrow();
  });
});

describe("metric completeness and improvement", () => {
  it("allows tied metrics alongside a strictly improved metric", () => {
    const values = reports();
    const next = {
      ...values[0].metrics[0],
      key: values[0].metrics[0].key.replace('"measured"', '"tied"'),
      ratios: [1, 0.9, 1, 1, 1, 1],
      status: "non-regressing",
    };
    values[0].metrics.push(next);
    values[0].timingMetricKeys.push(next.key);
    expect(validateBaselineReports(values, context).improvedMetrics).toBe(1);
  });
  it("rejects an omitted metric even when its file has another measured metric", () => {
    const values = reports();
    values[0].timingMetricKeys.push(
      values[0].timingMetricKeys[0].replace('"measured"', '"missing"'),
    );
    expect(() => validateBaselineReports(values, context)).toThrow("Missing timing metric");
  });
  it("rejects unchanged source with zero demonstrated improvements", () => {
    const values = reports().map((report) => ({
      ...report,
      identicalSource: true,
      anchorSourceHash: report.sourceHash,
      metrics: [],
      identicalInputs: [],
      improvedMetrics: 0,
    }));
    expect(() => validateBaselineReports(values, context)).toThrow("At least one");
  });
  it("rejects an identical-source claim that includes measured improvement", () => {
    const values = reports();
    values[0].identicalSource = true;
    expect(() => validateBaselineReports(values, context)).toThrow("identical-source");
  });
});

describe("workflow provenance", () => {
  const expected = {
    workflow: "ci.yml",
    head: "a".repeat(40),
    repository: "owner/repo",
    number: 3,
  };
  const run = {
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/ci.yml",
    head_sha: expected.head,
    repository: { full_name: expected.repository },
    pull_requests: [{ number: 3 }],
  };
  it("accepts the successful associated PR workflow", () => {
    expect(() => validateWorkflowRun(run, expected)).not.toThrow();
    expect(() => validateJobs([{ name: "CI", conclusion: "success" }], ["CI"])).not.toThrow();
  });
  it("accepts a merged workflow with GitHub's empty pull_requests association", () => {
    expect(() =>
      validateWorkflowRun(
        {
          ...run,
          id: 35082092472,
          head_sha: "cd6f4193cebf8b0f2fb66d4e3cf3a815b6b840b0",
          pull_requests: [],
        },
        { ...expected, number: 48, head: "cd6f4193cebf8b0f2fb66d4e3cf3a815b6b840b0" },
      ),
    ).not.toThrow();
  });
  it.each([
    { event: "workflow_dispatch" },
    { conclusion: "failure" },
    { status: "in_progress" },
    { head_sha: "b".repeat(40) },
    { path: ".github/workflows/other.yml" },
    { repository: { full_name: "fork/repo" } },
    { pull_requests: [{ number: 99 }] },
    { pull_requests: undefined },
  ])("rejects unrelated provenance %j", (override) => {
    expect(() => validateWorkflowRun({ ...run, ...override }, expected)).toThrow();
  });
  it.each([
    [],
    [{ name: "CI", conclusion: "skipped" }],
    [
      { name: "CI", conclusion: "success" },
      { name: "CI", conclusion: "success" },
    ],
  ])("requires a unique successful check", (...jobs) => {
    expect(() => validateJobs(jobs, ["CI"])).toThrow();
  });
});
