import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  batch: vi.fn(),
  inputs: vi.fn(),
  prepare: vi.fn(),
  dispose: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  baseline: vi.fn(),
}));
vi.mock("../../../scripts/performance-batch.mjs", () => ({ runPerformanceBatch: mocks.batch }));
vi.mock("../../../scripts/performance-inputs.mjs", () => ({ planPerformanceInputs: mocks.inputs }));
vi.mock("../../../scripts/performance-workspace.mjs", () => ({
  preparePerformanceWorkspaces: mocks.prepare,
  resolveLocalBaseline: mocks.baseline,
}));
vi.mock("node:fs/promises", () => ({
  readFile: mocks.read,
  writeFile: mocks.write,
  mkdir: mocks.mkdir,
  mkdtemp: mocks.mkdtemp,
}));

import { executePerformanceGate } from "../../../scripts/performance-gate.mjs";

const runs = [
  {
    label: "shared",
    refreshRate: 120,
    testFiles: ["/project/test/performance/domain/arrange-performance.test.ts"],
  },
  {
    label: "budget",
    refreshRate: 240,
    testFiles: ["/project/test/performance/domain/domain-performance.test.ts"],
  },
];
let workspaces;
function batchResult(options, actualMs = 100) {
  return {
    files: options.testFiles,
    durationMs: 10,
    violations: [],
    measurements: options.testFiles.map((file) => ({
      file,
      testName: "original p99",
      ordinal: 1,
      refreshRate: options.refreshRate,
      actualMs,
      referenceMs: 2,
      comparison: "lte",
    })),
  };
}
const savedReport = () => JSON.parse(mocks.write.mock.lastCall[1]);
const measurementCalls = () =>
  mocks.batch.mock.calls.filter(([options]) => options.mode === "measurement");

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "gate");
  vi.stubEnv("INKBOOK_PERFORMANCE_PROFILE", undefined);
  vi.stubEnv("INKBOOK_PERFORMANCE_BASE", undefined);
  vi.stubEnv("INKBOOK_PERFORMANCE_ANCHOR", undefined);
  vi.stubEnv("INKBOOK_PERFORMANCE_SUITE", undefined);
  vi.stubEnv("INKBOOK_PERFORMANCE_RESULTS_DIR", "/results");
  vi.stubEnv("CI", "true");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  workspaces = {
    metadata: { projectRoot: "/project" },
    candidate: { root: "/candidate", sourceHash: "candidate" },
    base: { root: "/base", sourceHash: "base" },
    anchor: { root: "/anchor", sourceHash: "anchor" },
    dispose: mocks.dispose,
  };
  mocks.prepare.mockResolvedValue(workspaces);
  mocks.read.mockResolvedValue(JSON.stringify({ anchorCommit: "fixed-anchor" }));
  mocks.baseline.mockReturnValue("fixed-anchor");
  mocks.mkdtemp.mockResolvedValue("/tmp/inkbook-performance-owned");
  mocks.batch.mockImplementation(async (options) => batchResult(options));
  mocks.inputs.mockImplementation(async ({ testFiles }) => ({
    pending: testFiles,
    identicalInputs: [],
    inputs: [],
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("baseline handoff", () => {
  it("uses the run-pinned reference and emits a handoff without additional measurements", async () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_ANCHOR", "run-pinned-anchor");
    vi.stubEnv("INKBOOK_PERFORMANCE_SUITE", "shared");
    vi.stubEnv("GITHUB_RUN_ID", "123");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    expect(await executePerformanceGate("/project", runs)).toEqual([]);
    expect(mocks.prepare).toHaveBeenCalledWith("/project", {
      base: "origin/main",
      anchor: "run-pinned-anchor",
    });
    expect(mocks.baseline).not.toHaveBeenCalled();
    expect(measurementCalls()).toHaveLength(48);
    const handoff = mocks.write.mock.calls.find(([path]) => path.endsWith("baseline-report.json"));
    expect(JSON.parse(handoff[1])).toMatchObject({
      version: 1,
      suite: "shared",
      runId: "123",
      runAttempt: "1",
      eligible: false,
    });
  });
});

describe("direct original-benchmark gate", () => {
  it("reuses input graphs across profiles while retaining every measurement and reference", async () => {
    const profiles = [60, 90, 120, 144, 240].map((refreshRate) => ({
      ...runs[0],
      refreshRate,
    }));
    expect(await executePerformanceGate("/project", profiles)).toEqual([]);
    expect(mocks.inputs).toHaveBeenCalledTimes(2);
    expect(mocks.inputs.mock.calls.map(([options]) => options.referenceRoot)).toEqual([
      "/base",
      "/anchor",
    ]);
    expect(mocks.batch).toHaveBeenCalledTimes(125);
    for (const { refreshRate } of profiles) {
      expect(
        measurementCalls().filter(([options]) => options.refreshRate === refreshRate),
      ).toHaveLength(24);
    }
    expect(savedReport().comparisons.map(({ metrics }) => metrics.length)).toEqual([5, 5]);
  });

  it("retains every contract and runs six balanced paired rounds against base and fixed anchor", async () => {
    expect(await executePerformanceGate("/project", runs)).toEqual([]);
    expect(mocks.batch).toHaveBeenCalledTimes(50);
    expect(mocks.inputs).toHaveBeenCalledTimes(4);
    const roots = measurementCalls().map(([options]) => options.root);
    expect(roots.filter((root) => root === "/base")).toHaveLength(12);
    expect(roots.filter((root) => root === "/anchor")).toHaveLength(12);
    expect(roots.filter((root) => root === "/candidate")).toHaveLength(24);
    for (let offset = 0; offset < roots.length; offset += 12) {
      const firstSides = roots.slice(offset, offset + 12).filter((_, index) => index % 2 === 0);
      expect(firstSides.filter((root) => root === "/candidate")).toHaveLength(3);
    }
    expect(mocks.prepare).toHaveBeenCalledWith("/project", {
      base: "origin/main",
      anchor: "fixed-anchor",
    });
    const report = savedReport();
    expect(report.comparisons.map(({ status }) => status)).toEqual(["pass", "pass"]);
    const measured = report.batches.find(({ mode }) => mode === "measurement");
    expect(measured.artifact).toMatch(
      /\/results\/base\/0\/shared\/120\/(reference|candidate)\/batch\.json$/u,
    );
    expect(measured.measurements).toBeUndefined();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("keeps all contracts while explicitly avoiding identical sources", async () => {
    workspaces.base.sourceHash = "candidate";
    workspaces.anchor.sourceHash = "candidate";
    expect(await executePerformanceGate("/project", runs)).toEqual([]);
    expect(mocks.batch).toHaveBeenCalledTimes(2);
    expect(mocks.inputs).not.toHaveBeenCalled();
    expect(savedReport().comparisons.map(({ status }) => status)).toEqual([
      "identical-source",
      "identical-source",
    ]);
  });

  it("deduplicates equal base/anchor sources without weakening the fixed-anchor comparison", async () => {
    workspaces.anchor = { ...workspaces.base };
    await executePerformanceGate("/project", runs);
    expect(measurementCalls()).toHaveLength(24);
    expect(savedReport().comparisons).toHaveLength(2);
  });

  it("accepts only complete per-file input identity proofs", async () => {
    mocks.inputs.mockImplementation(async ({ testFiles }) => ({
      pending: [],
      inputs: [],
      identicalInputs: testFiles.map((file) => ({
        file,
        inputHash: "a".repeat(64),
        inputs: ["src/main.ts"],
      })),
    }));
    expect(await executePerformanceGate("/project", runs)).toEqual([]);
    expect(measurementCalls()).toHaveLength(0);
    expect(savedReport().comparisons[0].identicalInputs).toHaveLength(2);
  });

  it("stores default evidence outside disposable workspaces", async () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_RESULTS_DIR", undefined);
    await executePerformanceGate("/project", runs);
    expect(savedReport().metadata.evidenceDirectory).toBe("/tmp/inkbook-performance-owned");
    expect(
      measurementCalls().every(([options]) =>
        options.reportDirectory.startsWith("/tmp/inkbook-performance-owned/"),
      ),
    ).toBe(true);
  });
});

describe("direct comparison failures", () => {
  it("runs every contract after a contract failure and suppresses comparisons", async () => {
    mocks.batch.mockImplementation(async (options) => ({
      ...batchResult(options),
      violations: [{ message: "contract failure" }],
    }));
    expect(await executePerformanceGate("/project", runs)).toHaveLength(2);
    expect(mocks.batch).toHaveBeenCalledTimes(2);
    expect(mocks.inputs).not.toHaveBeenCalled();
  });

  it.each([
    [[200, 200, 200], "regression"],
    [[149, 150, 151], "inconclusive"],
  ])("fails original timing values %j as %s", async (values, status) => {
    let candidate = 0;
    mocks.batch.mockImplementation(async (options) =>
      batchResult(
        options,
        options.mode === "measurement" && options.root === "/candidate"
          ? values[Math.floor(candidate++ / runs.length) % 3]
          : 100,
      ),
    );
    const violations = await executePerformanceGate("/project", runs);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every(({ message }) => message.startsWith(status))).toBe(true);
  });

  it("rejects missing original timing phases across rounds", async () => {
    let count = 0;
    mocks.batch.mockImplementation(async (options) => {
      const result = batchResult(options);
      if (options.mode === "measurement" && ++count === 5) result.measurements[0].ordinal = 2;
      return result;
    });
    await expect(executePerformanceGate("/project", runs)).rejects.toThrow("identity or contract");
  });

  it("rejects missing measurement files instead of passing an empty comparison", async () => {
    mocks.batch.mockImplementation(async (options) => ({
      ...batchResult(options),
      measurements: options.mode === "measurement" ? [] : batchResult(options).measurements,
    }));
    await expect(executePerformanceGate("/project", runs)).rejects.toThrow("timing population");
  });

  it.each([
    { pending: [], identicalInputs: [] },
    { pending: ["unknown"], identicalInputs: [] },
    {
      pending: [],
      identicalInputs: [
        {
          file: "test/performance/domain/arrange-performance.test.ts",
          inputHash: null,
          inputs: [],
        },
      ],
    },
  ])("rejects incomplete or invalid input plans", async (plan) => {
    mocks.inputs.mockResolvedValue(plan);
    await expect(executePerformanceGate("/project", runs)).rejects.toThrow();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("does not allow internal measurement or diagnostics to replace the CLI CI gate", async () => {
    for (const mode of ["measurement", "contracts", "reference"]) {
      vi.stubEnv("INKBOOK_PERFORMANCE_MODE", mode);
      await expect(executePerformanceGate("/project", runs)).rejects.toThrow();
    }
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("cleans workspaces even when artifact writes fail", async () => {
    mocks.write.mockRejectedValue(new Error("disk full"));
    await expect(executePerformanceGate("/project", runs)).rejects.toThrow("disk full");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});

describe("bounded comparison stages", () => {
  it("does not repeat decided files while collecting the final unresolved stage", async () => {
    workspaces.anchor = { ...workspaces.base };
    const combined = [{ ...runs[0], testFiles: runs.flatMap((run) => run.testFiles) }];
    mocks.batch.mockImplementation(async (options) => {
      const result = batchResult(options);
      for (const record of result.measurements) {
        if (
          options.mode === "measurement" &&
          options.root === "/candidate" &&
          record.file.endsWith("/arrange-performance.test.ts")
        )
          record.actualMs = 150;
      }
      return result;
    });
    const violations = await executePerformanceGate("/project", combined);
    expect(violations).toHaveLength(2);
    const calls = measurementCalls();
    expect(calls).toHaveLength(36);
    expect(calls.slice(0, 12).every(([options]) => options.testFiles.length === 2)).toBe(true);
    expect(
      calls
        .slice(12)
        .every(
          ([options]) =>
            options.testFiles.length === 1 &&
            options.testFiles[0].endsWith("/arrange-performance.test.ts"),
        ),
    ).toBe(true);
    expect(
      savedReport()
        .comparisons[0].metrics.map((metric) => [metric.status, metric.ratios.length])
        .sort(),
    ).toEqual([
      ["inconclusive", 18],
      ["pass", 6],
    ]);
  });

  it("uses the final stage only for an unresolved profile and never retries beyond it", async () => {
    workspaces.anchor = { ...workspaces.base };
    mocks.batch.mockImplementation(async (options) =>
      batchResult(
        options,
        options.mode === "measurement" &&
          options.root === "/candidate" &&
          options.refreshRate === 120
          ? 150
          : 100,
      ),
    );
    const violations = await executePerformanceGate("/project", runs);
    expect(violations).toHaveLength(2);
    expect(violations[0].message).toContain("inconclusive");
    expect(measurementCalls().filter(([options]) => options.refreshRate === 120)).toHaveLength(36);
    expect(measurementCalls().filter(([options]) => options.refreshRate === 240)).toHaveLength(12);
    const comparison = savedReport().comparisons[0];
    expect(comparison.orderPlans).toHaveLength(2);
    for (const { order } of comparison.orderPlans) {
      expect(order).toHaveLength(18);
      expect(order.slice(0, 6).filter((side) => side === "candidate")).toHaveLength(3);
      expect(order.slice(6).filter((side) => side === "candidate")).toHaveLength(6);
    }
  });
});
