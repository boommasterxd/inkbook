import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  batch: vi.fn(),
  kernel: vi.fn(),
  prepare: vi.fn(),
  dispose: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
}));
vi.mock("../../../scripts/performance-batch.mjs", () => ({ runPerformanceBatch: mocks.batch }));
vi.mock("../../../scripts/performance-kernel-batch.mjs", () => ({ runKernelBatch: mocks.kernel }));
vi.mock("../../../scripts/performance-workspace.mjs", () => ({
  preparePerformanceWorkspaces: mocks.prepare,
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
    label: "cadence",
    refreshRate: 240,
    testFiles: ["/project/test/performance/domain/domain-performance.test.ts"],
  },
];
let workspaces;

function result(options, actualMs = 100) {
  return {
    files: options.testFiles,
    durationMs: 10,
    violations: [],
    measurements: options.testFiles.map((file) => ({
      file,
      testName: "operation",
      ordinal: 1,
      refreshRate: options.refreshRate,
      actualMs,
      referenceMs: 2,
      comparison: "lte",
    })),
  };
}

function kernelResult(options, candidateMs = 100) {
  if (options.coverageOnly) return { kind: "kernel-coverage", ids: options.testFiles };
  return {
    measurements: [
      {
        id: options.testFiles[0],
        refreshRate: options.refreshRate,
        referenceMs: 100,
        candidateMs,
        statistics: [{ kind: "max", population: "samples" }],
        blocks: [
          {
            measurements: [
              { side: "reference", samplesMs: [100], operationWorkMs: [100] },
              { side: "candidate", samplesMs: [candidateMs], operationWorkMs: [candidateMs] },
            ],
          },
        ],
      },
    ],
    identicalInputs: [],
  };
}

function savedReport() {
  return JSON.parse(mocks.write.mock.lastCall[1]);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "gate");
  vi.stubEnv("INKBOOK_PERFORMANCE_PROFILE", undefined);
  vi.stubEnv("INKBOOK_PERFORMANCE_BASE", undefined);
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
  mocks.mkdtemp.mockResolvedValue("/tmp/inkbook-performance-owned");
  mocks.read.mockResolvedValue(JSON.stringify({ anchorCommit: "anchor-commit" }));
  mocks.batch.mockImplementation(async (options) => result(options));
  mocks.kernel.mockImplementation(async (options) => kernelResult(options));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("complete performance gate", () => {
  it("runs every contract batch even after failure and suppresses timing comparisons", async () => {
    mocks.batch.mockImplementation(async (options) => ({
      ...result(options),
      violations: [{ message: "contract failed" }],
    }));
    expect(await executePerformanceGate("/project", runs)).toHaveLength(2);
    expect(mocks.batch).toHaveBeenCalledTimes(2);
    expect(mocks.batch.mock.calls.every(([options]) => options.mode === "contracts")).toBe(true);
    expect(savedReport().comparisons).toEqual([]);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("reports identical source explicitly while retaining all contracts", async () => {
    workspaces.base.sourceHash = "candidate";
    workspaces.anchor.sourceHash = "candidate";
    expect(await executePerformanceGate("/project", runs)).toEqual([]);
    expect(mocks.batch).toHaveBeenCalledTimes(2);
    expect(savedReport().comparisons.map((comparison) => comparison.status)).toEqual([
      "identical-source",
      "identical-source",
    ]);
  });

  it("measures distinct base and anchor in three alternating paired rounds", async () => {
    expect(await executePerformanceGate("/project", runs)).toEqual([]);
    expect(mocks.kernel).toHaveBeenCalledTimes(13);
    expect(
      mocks.kernel.mock.calls
        .filter(([options]) => !options.coverageOnly)
        .map(([options]) => options.referenceRoot),
    ).toEqual([
      "/base",
      "/base",
      "/base",
      "/base",
      "/base",
      "/base",
      "/anchor",
      "/anchor",
      "/anchor",
      "/anchor",
      "/anchor",
      "/anchor",
    ]);
    expect(
      mocks.kernel.mock.calls
        .filter(([options]) => !options.coverageOnly)
        .map(([options]) => options.roundIndex),
    ).toEqual([0, 0, 1, 1, 2, 2, 0, 0, 1, 1, 2, 2]);
    expect(savedReport().comparisons.map(({ variant, status }) => [variant, status])).toEqual([
      ["base", "pass"],
      ["anchor", "pass"],
    ]);
    expect(mocks.prepare).toHaveBeenCalledWith("/project", {
      base: "origin/main",
      anchor: "anchor-commit",
    });
    expect(mocks.dispose).toHaveBeenCalledOnce();
    const paired = savedReport().batches.find(({ mode }) => mode === "paired");
    expect(paired.results).toBeUndefined();
    expect(paired).toMatchObject({
      measurementCount: 1,
      identicalInputCount: 0,
      artifact: "/results/base/0/shared/120/kernel.json",
    });
  });

  it("retains default raw artifacts outside disposable variant workspaces", async () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_RESULTS_DIR", undefined);
    await executePerformanceGate("/project", runs);
    expect(mocks.mkdtemp).toHaveBeenCalledOnce();
    expect(savedReport().metadata.evidenceDirectory).toBe("/tmp/inkbook-performance-owned");
    const paired = savedReport().batches.find(({ mode }) => mode === "paired");
    expect(paired.artifact).toBe("/tmp/inkbook-performance-owned/base/0/shared/120/kernel.json");
    expect(
      mocks.kernel.mock.calls.every(([options]) =>
        options.reportDirectory.startsWith("/tmp/inkbook-performance-owned/"),
      ),
    ).toBe(true);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("deduplicates a shared base and anchor workspace", async () => {
    workspaces.anchor = { ...workspaces.base };
    expect(await executePerformanceGate("/project", runs)).toEqual([]);
    expect(mocks.kernel).toHaveBeenCalledTimes(7);
    expect(savedReport().comparisons).toHaveLength(2);
  });
});

describe("performance gate failure handling", () => {
  it.each([
    [[200, 200, 200], "regression"],
    [[109, 110, 111], "inconclusive"],
  ])("fails candidate timings %j as %s", async (values, status) => {
    let candidateCalls = 0;
    mocks.kernel.mockImplementation(async (options) =>
      kernelResult(
        options,
        options.coverageOnly ? 100 : values[Math.floor(candidateCalls++ / runs.length) % 3],
      ),
    );
    const violations = await executePerformanceGate("/project", runs);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every(({ message }) => message.startsWith(status))).toBe(true);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a missing candidate timing population instead of passing", async () => {
    mocks.kernel.mockImplementation(async (options) =>
      options.coverageOnly ? kernelResult(options) : { measurements: [], identicalInputs: [] },
    );
    await expect(executePerformanceGate("/project", runs)).rejects.toThrow(
      "Missing paired results",
    );
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("requires timing telemetry even when candidate and references have identical source", async () => {
    workspaces.base.sourceHash = "candidate";
    workspaces.anchor.sourceHash = "candidate";
    mocks.batch.mockImplementation(async (options) => ({ ...result(options), measurements: [] }));
    const violations = await executePerformanceGate("/project", runs);
    expect(violations).toHaveLength(2);
    expect(violations.every(({ test }) => test === "Timing coverage")).toBe(true);
    expect(savedReport().comparisons).toEqual([]);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});

describe("original tail statistic enforcement", () => {
  it("fails rare slow steps even when mean work remains below the regression limit", async () => {
    mocks.kernel.mockImplementation(async (options) => {
      const report = kernelResult(options, 103.5);
      if (options.coverageOnly) return report;
      const measured = report.measurements[0];
      measured.statistics = [{ kind: "p99", population: "samples", minimumSamples: 100 }];
      measured.blocks[0].measurements[0].samplesMs = Array(600).fill(100);
      measured.blocks[0].measurements[1].samplesMs = [
        ...Array(593).fill(100),
        ...Array(7).fill(400),
      ];
      return report;
    });
    const violations = await executePerformanceGate("/project", runs);
    expect(violations.length).toBeGreaterThan(0);
    const metrics = savedReport().comparisons[0].metrics;
    expect(
      metrics
        .filter(({ key }) => key.includes("mean-work"))
        .every(({ status }) => status === "pass"),
    ).toBe(true);
    expect(
      metrics
        .filter(({ key }) => key.includes("samples:p99"))
        .every(({ status }) => status === "regression"),
    ).toBe(true);
  });

  it("fails missing original statistic contracts instead of accepting work-only evidence", async () => {
    mocks.kernel.mockImplementation(async (options) => {
      const report = kernelResult(options);
      if (!options.coverageOnly) delete report.measurements[0].statistics;
      return report;
    });
    await expect(executePerformanceGate("/project", runs)).rejects.toThrow("statistics");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});

describe("performance gate identity evidence", () => {
  it("retains stable identical-input proofs instead of manufacturing timing results", async () => {
    mocks.kernel.mockImplementation(async (options) =>
      options.coverageOnly
        ? kernelResult(options)
        : {
            measurements: [],
            identicalInputs: [
              {
                id: options.testFiles[0],
                refreshRate: options.refreshRate,
                inputHash: "a".repeat(64),
                inputs: ["src/domain/store/public.ts"],
              },
            ],
          },
    );
    expect(await executePerformanceGate("/project", runs)).toEqual([]);
    expect(savedReport().comparisons.map(({ status }) => status)).toEqual([
      "identical-inputs",
      "identical-inputs",
    ]);
    expect(savedReport().comparisons[0].identicalInputs).toHaveLength(2);
  });

  it("rejects changing identity proofs between rounds", async () => {
    let call = 0;
    mocks.kernel.mockImplementation(async (options) =>
      options.coverageOnly
        ? kernelResult(options)
        : {
            measurements: [],
            identicalInputs: [
              {
                id: options.testFiles[0],
                refreshRate: options.refreshRate,
                inputHash: (call++ < 2 ? "a" : "b").repeat(64),
                inputs: ["src/domain/store/public.ts"],
              },
            ],
          },
    );
    await expect(executePerformanceGate("/project", runs)).rejects.toThrow(
      "populations differ across rounds",
    );
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it.each(["duplicate", "wrong-profile", "invalid-hash"])(
    "rejects %s evidence",
    async (failure) => {
      mocks.kernel.mockImplementation(async (options) => {
        const output = kernelResult(options);
        if (options.coverageOnly) return output;
        const id = options.testFiles[0];
        if (failure === "wrong-profile") output.measurements[0].refreshRate = 60;
        else
          output.identicalInputs.push({
            id,
            refreshRate: options.refreshRate,
            inputHash: failure === "invalid-hash" ? null : "a".repeat(64),
            inputs: ["src/main.ts"],
          });
        return output;
      });
      await expect(executePerformanceGate("/project", runs)).rejects.toThrow();
      expect(mocks.dispose).toHaveBeenCalledOnce();
    },
  );

  it("validates registry coverage even when every source hash is identical", async () => {
    workspaces.base.sourceHash = "candidate";
    workspaces.anchor.sourceHash = "candidate";
    mocks.kernel.mockResolvedValue({ kind: "kernel-coverage", ids: [] });
    await expect(executePerformanceGate("/project", runs)).rejects.toThrow("coverage evidence");
    expect(mocks.kernel).toHaveBeenCalledWith(
      expect.objectContaining({
        coverageOnly: true,
        reportDirectory: "/results/coverage",
        contractMeasurements: expect.any(Array),
      }),
    );
    expect(savedReport().comparisons).toEqual([]);
  });

  it("rejects an empty execution plan before allocating resources", async () => {
    await expect(executePerformanceGate("/project", [])).rejects.toThrow("Empty performance");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});

describe("performance gate resource cleanup", () => {
  it("cleans up when comparison execution fails", async () => {
    mocks.kernel.mockRejectedValue(new Error("batch crashed"));
    await expect(executePerformanceGate("/project", runs)).rejects.toThrow("batch crashed");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("cleans up even when evidence cannot be written", async () => {
    mocks.write.mockRejectedValue(new Error("disk full"));
    await expect(executePerformanceGate("/project", runs)).rejects.toThrow("disk full");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("rejects diagnostic CI modes and legacy multipliers before preparing workspaces", async () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "contracts");
    await expect(executePerformanceGate("/project", runs)).rejects.toThrow("diagnostic");
    vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "reference");
    await expect(executePerformanceGate("/project", runs)).rejects.toThrow("diagnostic");
    vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "gate");
    vi.stubEnv("INKBOOK_PERFORMANCE_PROFILE", "hosted-ubuntu");
    await expect(executePerformanceGate("/project", runs)).rejects.toThrow("multipliers");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
