import { describe, expect, it } from "vitest";

import { PERFORMANCE_TEST_MANIFEST } from "../../../scripts/performance-test-manifest.mjs";
import { selectPerformanceRuns } from "../../../scripts/performance-test-runner.mjs";
import { summarizePerformanceCalibration } from "../../../scripts/summarize-performance-calibration.mjs";

function artifacts() {
  return [1, 2, 3].flatMap((sample) =>
    ["shared", "cadence"].map((suite) => ({
      sample,
      suite,
      metadata: {
        commit: "a".repeat(40),
        sourceTree: "b".repeat(40),
        lockSha256: "c".repeat(64),
        node: "v26.7.0",
        dirty: false,
        profile: "hosted-ubuntu",
        platform: "linux",
        image: "ubuntu24",
        runId: "12345",
        runAttempt: "1",
        cpuModel: "test CPU",
      },
      results: selectPerformanceRuns(PERFORMANCE_TEST_MANIFEST, suite).flatMap((run) =>
        run.testFiles.map((file) => ({
          file,
          refreshRate: run.refreshRate,
          violations: [],
          measurements: [
            {
              testName: "operation",
              testPath: `/runner/${sample}/${file}`,
              ordinal: 1,
              actualMs: sample,
              referenceMs: 2,
              limitMs: 10,
              ratio: sample / 2,
              refreshRate: run.refreshRate,
              comparison: "lte",
            },
          ],
        })),
      ),
    })),
  );
}

function firstMeasurement(input) {
  return input[0].results[0].measurements[0];
}

const invalidCases = [
  [
    "mixed limits",
    (input) => {
      firstMeasurement(input).limitMs = 20;
    },
  ],
  [
    "local profile",
    (input) => {
      input[0].metadata.profile = "reference";
    },
  ],
  [
    "non-Linux",
    (input) => {
      input[0].metadata.platform = "darwin";
    },
  ],
  [
    "missing image",
    (input) => {
      delete input[0].metadata.image;
    },
  ],
  [
    "missing hosted run",
    (input) => {
      delete input[0].metadata.runId;
    },
  ],
  [
    "mixed hosted runs",
    (input) => {
      input[0].metadata.runId = "54321";
    },
  ],
  [
    "mixed attempts",
    (input) => {
      input[0].metadata.runAttempt = "2";
    },
  ],
  ["missing artifact", (input) => input.pop()],
  [
    "duplicate artifact",
    (input) => {
      input[5] = input[0];
    },
  ],
  [
    "invalid sample",
    (input) => {
      input[0].sample = 4;
    },
  ],
  [
    "different commit",
    (input) => {
      input[1].metadata.commit = "d".repeat(40);
    },
  ],
  [
    "different source tree",
    (input) => {
      input[1].metadata.sourceTree = "d".repeat(40);
    },
  ],
  [
    "different lock",
    (input) => {
      input[1].metadata.lockSha256 = "d".repeat(64);
    },
  ],
  [
    "different node",
    (input) => {
      input[1].metadata.node = "v26.8.0";
    },
  ],
  [
    "dirty commit",
    (input) => {
      input[0].metadata.dirty = true;
    },
  ],
  ["missing file", (input) => input[0].results.pop()],
  ["duplicate file", (input) => input[0].results.push(input[0].results[0])],
  [
    "unknown file",
    (input) => {
      input[0].results[0].file = "unknown.test.ts";
    },
  ],
  ["failure", (input) => input[0].results[0].violations.push("assertion failed")],
  [
    "missing report",
    (input) => {
      input[0].results[0].measurements = undefined;
    },
  ],
  [
    "missing metric",
    (input) => {
      input[0].results[0].measurements = [];
    },
  ],
  [
    "invalid number",
    (input) => {
      firstMeasurement(input).actualMs = NaN;
    },
  ],
  [
    "wrong ratio",
    (input) => {
      firstMeasurement(input).ratio = 99;
    },
  ],
  [
    "wrong refresh rate",
    (input) => {
      firstMeasurement(input).refreshRate = 240;
    },
  ],
  ["duplicate metric", (input) => input[0].results[0].measurements.push(firstMeasurement(input))],
  [
    "different comparison",
    (input) => {
      firstMeasurement(input).comparison = "lt";
    },
  ],
  [
    "different identity",
    (input) => {
      firstMeasurement(input).testName = "other";
    },
  ],
  [
    "different reference",
    (input) => {
      firstMeasurement(input).referenceMs = 1;
      firstMeasurement(input).ratio = 1;
    },
  ],
  [
    "empty population",
    (input) => {
      for (const artifact of input) {
        for (const result of artifact.results) result.measurements = [];
      }
    },
  ],
];

describe("hosted performance calibration summary", () => {
  it("retains every metric and metadata record and uses the greatest ratio with fixed headroom", () => {
    const input = artifacts();
    const original = structuredClone(input);
    expect(input[0].results).toHaveLength(40);
    expect(input[1].results).toHaveLength(50);
    const summary = summarizePerformanceCalibration(input);
    expect(summary.metadata).toHaveLength(6);
    expect(summary.metadata[0].cpuModel).toBe("test CPU");
    expect(summary.metrics).toHaveLength(90);
    expect(summary.metrics[0].actualMs).toEqual([1, 2, 3]);
    expect(summary.maxRatio).toBe(1.5);
    expect(summary.candidate).toBe(2);
    expect(summary.candidates).toEqual({ shared: 2, cadence: 2 });
    expect(input).toEqual(original);
  });

  it("uses every sample, handles strict comparisons, and never returns a factor below one", () => {
    const input = artifacts();
    for (const artifact of input) {
      for (const result of artifact.results) {
        result.measurements[0].actualMs = 0;
        result.measurements[0].ratio = 0;
        result.measurements[0].comparison = "lt";
      }
    }
    expect(summarizePerformanceCalibration(input).candidate).toBe(1);
    firstMeasurement(input).actualMs = 7;
    firstMeasurement(input).ratio = 3.5;
    expect(summarizePerformanceCalibration(input).candidate).toBe(4.5);
    expect(summarizePerformanceCalibration(input).candidates).toEqual({ shared: 4.5, cadence: 1 });
  });

  it("retains evidence but blocks adoption when the required factor exceeds five", () => {
    const input = artifacts();
    firstMeasurement(input).actualMs = 9;
    firstMeasurement(input).ratio = 4.5;
    const summary = summarizePerformanceCalibration(input);
    expect(summary.candidate).toBe(5.75);
    expect(summary.adoptionBlocked).toBe(true);
    expect(summary.metrics[0].actualMs).toEqual([9, 2, 3]);
  });

  it.each(invalidCases)("rejects %s without deriving a candidate", (_label, mutate) => {
    const input = artifacts();
    mutate(input);
    expect(() => summarizePerformanceCalibration(input)).toThrow();
  });
});
