import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const timers = vi.hoisted(() => ({ setTimeout: vi.fn(), clearTimeout: vi.fn() }));
vi.mock("node:timers", () => timers);
import { spawn } from "node:child_process";
import { parseBatchReport, runPerformanceBatch } from "../../../scripts/performance-batch.mjs";

const root = "/workspace";
const file = "test/performance/a.test.ts";
const secondFile = "test/performance/b.test.ts";
const measurement = {
  testName: "operation",
  testPath: `${root}/${file}`,
  ordinal: 1,
  actualMs: 4,
  referenceMs: 2,
  ratio: 2,
  refreshRate: 240,
  comparison: "lte",
};
const testResult = (name = file) => ({
  name: `${root}/${name}`,
  status: "passed",
  assertionResults: [{ fullName: "operation", status: "passed" }],
});
const envelope = (name = file, measurements = [measurement]) =>
  `INKBOOK_TIMING_RECORDS ${JSON.stringify({ testPath: `${root}/${name}`, measurements })}\n`;
const report = (overrides = {}) => ({
  root,
  testFiles: [file],
  refreshRate: 240,
  stdout: JSON.stringify({ success: true, testResults: [testResult()] }),
  stderr: envelope(),
  ...overrides,
});

function mockChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    child.emit("close", null, "SIGKILL");
    return true;
  });
  vi.mocked(spawn).mockReturnValue(child);
  return child;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("performance batch reports", () => {
  it("preserves all files, including a file with no timing assertions", () => {
    const parsed = parseBatchReport(
      report({
        testFiles: [file, secondFile],
        stdout: JSON.stringify({
          success: true,
          testResults: [testResult(), testResult(secondFile)],
        }),
        stderr: `diagnostic\n${envelope()}${envelope(secondFile, [])}`,
      }),
    );
    expect(parsed.files).toEqual([file, secondFile]);
    expect(parsed.measurements).toEqual([{ ...measurement, file }]);
    expect(parsed.violations).toEqual([]);
  });

  it("preserves timing records through JSON envelopes", () => {
    const records = [measurement, { ...measurement, ordinal: 2 }];
    const parsed = parseBatchReport(report({ stderr: envelope(file, records) }));
    expect(parsed.measurements).toEqual(records.map((record) => ({ ...record, file })));
    expect(parsed.measurements[0]).not.toHaveProperty("statistic");
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });

  it.each(["pending", "todo", "skipped", "failed"])("rejects %s tests", (status) => {
    const result = testResult();
    result.assertionResults[0].status = status;
    expect(
      parseBatchReport(
        report({ stdout: JSON.stringify({ success: false, testResults: [result] }) }),
      ).violations,
    ).toEqual([expect.objectContaining({ test: "operation", message: `Test status: ${status}` })]);
  });

  it.each([
    { stderr: "" },
    { stderr: envelope() + envelope() },
    { stderr: envelope(secondFile, []) },
    { stderr: "INKBOOK_TIMING_RECORDS {\n" },
    { stdout: "invalid" },
    { stdout: JSON.stringify({ success: true, testResults: [] }) },
    { stdout: JSON.stringify({ success: true, testResults: [testResult(), testResult()] }) },
    { stdout: JSON.stringify({ success: true, testResults: [testResult(secondFile)] }) },
    { stdout: JSON.stringify({ success: false, testResults: [testResult()] }) },
    { testFiles: [file, file] },
    { testFiles: ["../escape.test.ts"] },
    { testFiles: [] },
    { refreshRate: 75 },
  ])("fails closed for incomplete or malformed reports %j", (override) => {
    expect(() => parseBatchReport(report(override))).toThrow();
  });

  it.each([
    { statistic: "median" },
    { statistic: null },
    { statistic: "p99" },
    { statistic: "mean" },
    { statistic: 1.1 },
    { statistic: {} },
    { actualMs: -1 },
    { referenceMs: 0 },
    { ratio: 3 },
    { ordinal: 2 },
    { refreshRate: 120 },
    { comparison: "unknown" },
    { testName: "" },
    { testPath: `${root}/${secondFile}` },
    { label: 12 },
  ])("rejects malformed measurements %j", (override) => {
    expect(() =>
      parseBatchReport(report({ stderr: envelope(file, [{ ...measurement, ...override }]) })),
    ).toThrow();
  });

  it("rejects duplicate ordinals and invalid populations", () => {
    expect(() =>
      parseBatchReport(report({ stderr: envelope(file, [measurement, measurement]) })),
    ).toThrow("ordinal");
    expect(() => parseBatchReport(report({ stderr: envelope(file, null) }))).toThrow("population");
    expect(() =>
      parseBatchReport(
        report({
          stderr: envelope(
            file,
            Array.from({ length: 20_001 }, () => measurement),
          ),
        }),
      ),
    ).toThrow("population");
  });
});

describe("bounded performance batch execution", () => {
  it("uses one isolated worker and removes the legacy multiplier", async () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_PROFILE", "hosted-ubuntu");
    const child = mockChild();
    const pending = runPerformanceBatch({
      root,
      testFiles: [secondFile, file],
      refreshRate: 240,
      mode: "measurement",
    });
    child.stdout.write(
      JSON.stringify({ success: true, testResults: [testResult(), testResult(secondFile)] }),
    );
    child.stderr.write(envelope() + envelope(secondFile, []));
    child.emit("close", 0, null);
    expect((await pending).violations).toEqual([]);
    const [, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(args).toContain("--maxWorkers=1");
    expect(args).toContain("--isolate");
    expect(args).toContain("--fileParallelism=false");
    expect(args).toContain("--cache=false");
    expect(args.indexOf(file)).toBeLessThan(args.indexOf(secondFile));
    expect(options.env.INKBOOK_PERFORMANCE_MODE).toBe("measurement");
    expect(options.env.INKBOOK_PERFORMANCE_PROFILE).toBeUndefined();
    expect(options.detached).toBeUndefined();
  });

  it("leaves ordinary contract cache behavior unchanged", async () => {
    const child = mockChild();
    const pending = runPerformanceBatch({
      root,
      testFiles: [file],
      refreshRate: 240,
      mode: "contracts",
    });
    child.stdout.write(report().stdout);
    child.stderr.write(report().stderr);
    child.emit("close", 0, null);
    expect((await pending).violations).toEqual([]);
    expect(vi.mocked(spawn).mock.calls[0][1]).not.toContain("--cache=false");
  });

  it("terminates its child when the fixed duration expires", async () => {
    const child = mockChild();
    const pending = runPerformanceBatch({
      root,
      testFiles: [file],
      refreshRate: 240,
      mode: "contracts",
    });
    const [onTimeout, duration] = timers.setTimeout.mock.calls[0];
    expect(duration).toBe(10 * 60 * 1000);
    onTimeout();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect((await pending).violations).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("10 minutes") }),
    );
  });

  it("terminates on combined output overflow", async () => {
    const child = mockChild();
    const pending = runPerformanceBatch({
      root,
      testFiles: [file],
      refreshRate: 240,
      mode: "reference",
    });
    child.stdout.write("a".repeat(16 * 1024 * 1024));
    child.stderr.write("b".repeat(16 * 1024 * 1024 + 1));
    expect((await pending).violations).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("32 MiB") }),
    );
  });

  it("reports process startup failure and rejects unsupported modes", async () => {
    const child = mockChild();
    const pending = runPerformanceBatch({
      root,
      testFiles: [file],
      refreshRate: 240,
      mode: "contracts",
    });
    child.emit("error", new Error("spawn failed"));
    expect((await pending).violations).toContainEqual(
      expect.objectContaining({ message: "spawn failed" }),
    );
    await expect(
      runPerformanceBatch({ root, testFiles: [file], refreshRate: 240, mode: "loose" }),
    ).rejects.toThrow("mode");
  });
});

describe("relative-only batch records", () => {
  const relative = {
    ...measurement,
    referenceMs: null,
    limitMs: null,
    ratio: null,
    comparison: "relative",
    label: "total work",
  };

  it("round-trips relative and absolute metrics in one envelope", () => {
    const parsed = parseBatchReport(
      report({ stderr: envelope(file, [measurement, { ...relative, ordinal: 2 }]) }),
    );
    expect(JSON.parse(JSON.stringify(parsed)).measurements).toEqual([
      { ...measurement, file },
      { ...relative, ordinal: 2, file },
    ]);
  });

  it.each([
    { referenceMs: 2 },
    { referenceMs: undefined },
    { limitMs: 2 },
    { limitMs: undefined },
    { ratio: 2 },
    { ratio: undefined },
    { label: undefined },
    { label: " " },
    { label: 12 },
    { comparison: "lte" },
    { actualMs: -1 },
  ])("rejects malformed relative shape %j", (override) => {
    expect(() =>
      parseBatchReport(report({ stderr: envelope(file, [{ ...relative, ...override }]) })),
    ).toThrow();
  });

  it.each([{ referenceMs: null }, { limitMs: null }, { ratio: null }, { comparison: "relative" }])(
    "rejects a mixed absolute shape %j",
    (override) => {
      expect(() =>
        parseBatchReport(report({ stderr: envelope(file, [{ ...measurement, ...override }]) })),
      ).toThrow();
    },
  );
});
