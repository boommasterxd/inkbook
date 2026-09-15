import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
import { execFile } from "node:child_process";
import {
  normalizeKernelFiles,
  runKernelBatch,
  validateKernelProcessReport,
  validateKernelScenarios,
  createKernelProgressReporter,
  configureKernelVitest,
} from "../../../scripts/performance-kernel-batch.mjs";

import { runPairedScenarios } from "../../performance/comparison/paired-runner.ts";

const roots = [];
const file = "test/performance/domain/arrange-performance.test.ts";
const passed = {
  success: true,
  testResults: [{ status: "passed", assertionResults: [{ status: "passed" }] }],
};
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkbook-kernel-batch-test-"));
  roots.push(root);
  return {
    root,
    referenceRoot: root,
    candidateRoot: root,
    testFiles: [file],
    refreshRate: 240,
    reportDirectory: join(root, "reports"),
  };
}

function successfulProcess(report) {
  vi.mocked(execFile).mockImplementation((_command, _args, options, callback) => {
    async function complete() {
      const directory = (await readdir(options.cwd)).find((name) =>
        name.startsWith(".inkbook-kernel-"),
      );
      const driver = await readFile(join(options.cwd, directory, "driver.test.ts"), "utf8");
      const data = JSON.parse(driver.match(/const options = (.+);/)[1]);
      await writeFile(data.resultPath, JSON.stringify(report));
      callback(null, { stdout: JSON.stringify(passed), stderr: "diagnostic" });
    }
    complete().catch(callback);
  });
}

describe("comparison batch driver", () => {
  it("returns raw results from one bounded isolated process and cleans its workspace", async () => {
    const options = await fixture();
    vi.stubEnv("INKBOOK_PERFORMANCE_PROFILE", "hosted-ubuntu");
    const expected = { measurements: [{ id: "arrange", raw: [1, 2, 3] }], identicalInputs: [] };
    successfulProcess(expected);
    expect(await runKernelBatch(options)).toEqual(expected);
    expect(execFile).toHaveBeenCalledTimes(1);
    const [, args, processOptions] = vi.mocked(execFile).mock.calls[0];
    expect(args).toContain("--expose-gc");
    expect(args).toContain("--maxWorkers=1");
    expect(processOptions.timeout).toBe(720_000);
    expect(processOptions.maxBuffer).toBe(32 * 1024 * 1024);
    expect(processOptions.killSignal).toBe("SIGKILL");
    expect(processOptions.env.INKBOOK_PERFORMANCE_PROFILE).toBeUndefined();
    expect(processOptions.env.INKBOOK_PERFORMANCE_MODE).toBe("contracts");
    expect((await readdir(options.root)).some((name) => name.startsWith(".inkbook-kernel-"))).toBe(
      false,
    );
    expect(await readFile(join(options.reportDirectory, "kernel-stderr.log"), "utf8")).toBe(
      "diagnostic",
    );
  });

  it("retains failure diagnostics and removes temporary driver files", async () => {
    const options = await fixture();
    vi.mocked(execFile).mockImplementation((_command, _args, _options, callback) =>
      callback(Object.assign(new Error("timed out"), { stderr: "worker error" })),
    );
    await expect(runKernelBatch(options)).rejects.toThrow("timed out");
    expect(await readFile(join(options.reportDirectory, "kernel-stderr.log"), "utf8")).toBe(
      "worker error",
    );
    expect((await readdir(options.root)).some((name) => name.startsWith(".inkbook-kernel-"))).toBe(
      false,
    );
  });

  it("allows validation-only report delivery", async () => {
    const options = await fixture();
    const expected = { kind: "kernel-validation", success: true, scenarios: ["arrange"] };
    successfulProcess(expected);
    expect(await runKernelBatch({ ...options, validationOnly: true })).toEqual(expected);
  });

  it("rejects forceComparison on CI before starting a process", async () => {
    const options = await fixture();
    vi.stubEnv("CI", "true");
    await expect(runKernelBatch({ ...options, forceComparison: true })).rejects.toThrow(
      "local diagnostic",
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([[], [file, file], ["../outside.test.ts"], ["src/main.ts"]])(
    "rejects invalid selected files",
    (files) => {
      expect(() => normalizeKernelFiles("/workspace", files)).toThrow();
    },
  );

  it.each([
    {},
    { success: false },
    { ...passed, testResults: [] },
    { ...passed, testResults: [{ status: "passed", assertionResults: [{ status: "skipped" }] }] },
  ])("rejects missing or unsuccessful process evidence", (report) => {
    expect(() => validateKernelProcessReport(JSON.stringify(report))).toThrow();
  });
});

describe("kernel validation protocol", () => {
  it.each(["sequence", "async-sequence"])(
    "consumes %s generators in matched alternating order",
    async (execution) => {
      const reference = { side: "reference" };
      const candidate = { side: "candidate" };
      const steps = [];
      const completed = [];
      const disposed = [];
      const scenario = {
        id: "small-sequence",
        execution,
        sequenceLength: 2,
        create(implementation) {
          function* sequence() {
            steps.push(`${implementation.side}:first`);
            yield;
            steps.push(`${implementation.side}:second`);
            yield;
            return implementation.side;
          }
          return {
            run: sequence,
            measurementSamples: () => [1, 2],
            verify: (value) => completed.push(value),
            dispose: () => disposed.push(implementation.side),
          };
        },
      };
      await validateKernelScenarios({
        scenarios: [scenario],
        reference,
        candidate,
        refreshRate: 120,
        runPairedScenarios,
      });
      expect(steps).toEqual([
        "reference:first",
        "candidate:first",
        "candidate:second",
        "reference:second",
      ]);
      expect(completed).toEqual(["reference", "candidate"]);
      expect(disposed.toSorted()).toEqual(["candidate", "reference"]);
    },
  );

  it("validates all sequence metrics together and propagates the round", async () => {
    const scenarios = [
      { execution: "sequence", id: "first" },
      { execution: "async-sequence", id: "second" },
    ];
    const paired = vi.fn();
    await validateKernelScenarios({
      scenarios,
      reference: {},
      candidate: {},
      refreshRate: 120,
      roundIndex: 2,
      runPairedScenarios: paired,
    });
    expect(paired).toHaveBeenCalledOnce();
    expect(paired).toHaveBeenCalledWith(expect.objectContaining({ scenarios, roundIndex: 2 }));
  });

  it.each([-1, 3, 1.5, NaN])("rejects invalid fresh-process round %s", async (roundIndex) => {
    const options = await fixture();
    await expect(runKernelBatch({ ...options, roundIndex })).rejects.toThrow("round index");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("validates atomic operations once per side without invoking the paired timing protocol", async () => {
    const create = vi.fn(() => ({
      reset: vi.fn(),
      run: vi.fn(() => "value"),
      verify: vi.fn(),
      dispose: vi.fn(),
    }));
    const paired = vi.fn();
    await validateKernelScenarios({
      scenarios: [{ execution: "sync", create }],
      reference: {},
      candidate: {},
      refreshRate: 120,
      runPairedScenarios: paired,
    });
    expect(paired).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
    for (const { value } of create.mock.results) {
      expect(value.reset).toHaveBeenCalledOnce();
      expect(value.run).toHaveBeenCalledOnce();
      expect(value.verify).toHaveBeenCalledWith("value");
      expect(value.dispose).toHaveBeenCalledOnce();
    }
  });
});

describe("bounded kernel memory diagnostics", () => {
  it("records one bounded memory snapshot outside the kernel operation", () => {
    const write = vi.fn();
    const memoryUsage = vi.fn(() => ({
      heapUsed: 10,
      heapTotal: 20,
      rss: 30,
      external: 4,
      arrayBuffers: 5,
    }));
    const progress = createKernelProgressReporter({ write, memoryUsage });
    progress({ phase: "start", ids: ["large-history"] });
    expect(memoryUsage).toHaveBeenCalledOnce();
    expect(JSON.parse(write.mock.calls[0][0].slice("INKBOOK_KERNEL_PROGRESS ".length))).toEqual({
      phase: "start",
      ids: ["large-history"],
      heapUsed: 10,
      heapTotal: 20,
      rss: 30,
      external: 4,
      arrayBuffers: 5,
    });
  });

  it("rejects excessive diagnostics instead of accumulating unbounded output", () => {
    const progress = createKernelProgressReporter({ write: () => {}, memoryUsage: () => ({}) });
    for (let index = 0; index < 2048; index += 1) progress({ phase: "end", ids: [] });
    expect(() => progress({ phase: "end", ids: [] })).toThrow("bounded");
    expect(() =>
      createKernelProgressReporter()({ phase: "start", ids: Array(501).fill("x") }),
    ).toThrow("bounded");
  });
});

describe("paired comparison worker memory", () => {
  it("bounds only the two-variant comparison worker at 768 MiB while retaining GC and original contracts", () => {
    const base = {
      test: { execArgv: ["--max-old-space-size=384", "--expose-gc"], environment: "node" },
    };
    const configured = configureKernelVitest(base, {
      driverPath: "/driver.test.ts",
      temporary: "/temporary",
    });
    expect(configured.test.execArgv).toEqual(["--expose-gc", "--max-old-space-size=768"]);
    expect(configured.test.maxWorkers).toBe(1);
    expect(configured.test.environment).toBe("happy-dom");
    expect(base.test.execArgv).toEqual(["--max-old-space-size=384", "--expose-gc"]);
    expect(base.test.environment).toBe("node");
  });
});
