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
const testResult = (name = file) => ({
  name: `${root}/${name}`,
  status: "passed",
  assertionResults: [{ fullName: "operation", status: "passed" }],
});
const report = (overrides = {}) => ({
  root,
  testFiles: [file],
  refreshRate: 240,
  stdout: JSON.stringify({ success: true, testResults: [testResult()] }),
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
  it("checks all files without collecting elapsed-time evidence", () => {
    const parsed = parseBatchReport(
      report({
        testFiles: [file, secondFile],
        stdout: JSON.stringify({
          success: true,
          testResults: [testResult(), testResult(secondFile)],
        }),
      }),
    );
    expect(parsed).toEqual({ files: [file, secondFile], violations: [] });
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
});

describe("bounded performance batch execution", () => {
  it("uses one isolated worker and removes the legacy multiplier", async () => {
    const child = mockChild();
    const pending = runPerformanceBatch({
      root,
      testFiles: [secondFile, file],
      refreshRate: 240,
    });
    child.stdout.write(
      JSON.stringify({ success: true, testResults: [testResult(), testResult(secondFile)] }),
    );
    child.emit("close", 0, null);
    expect((await pending).violations).toEqual([]);
    const [, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(args).toContain("--maxWorkers=1");
    expect(args).toContain("--isolate");
    expect(args).toContain("--fileParallelism=false");
    expect(args).toContain("--reporter=json");
    expect(args).not.toContain("--cache=false");
    expect(args.indexOf(file)).toBeLessThan(args.indexOf(secondFile));
    expect(options.env.INKBOOK_PERFORMANCE_REFRESH_RATE).toBe("240");
    expect(options.detached).toBeUndefined();
  });

  it("terminates its child when the fixed duration expires", async () => {
    const child = mockChild();
    const pending = runPerformanceBatch({
      root,
      testFiles: [file],
      refreshRate: 240,
    });
    const [onTimeout, duration] = timers.setTimeout.mock.calls[0];
    expect(duration).toBe(20 * 60 * 1000);
    onTimeout();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect((await pending).violations).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("20 minutes") }),
    );
  });

  it("terminates on combined output overflow", async () => {
    const child = mockChild();
    const pending = runPerformanceBatch({
      root,
      testFiles: [file],
      refreshRate: 240,
    });
    child.stdout.write("a".repeat(16 * 1024 * 1024));
    child.stderr.write("b".repeat(16 * 1024 * 1024 + 1));
    expect((await pending).violations).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("32 MiB") }),
    );
  });

  it("reports process startup failure and rejects unsupported profiles", async () => {
    const child = mockChild();
    const pending = runPerformanceBatch({
      root,
      testFiles: [file],
      refreshRate: 240,
    });
    child.emit("error", new Error("spawn failed"));
    expect((await pending).violations).toContainEqual(
      expect.objectContaining({ message: "spawn failed" }),
    );
    await expect(runPerformanceBatch({ root, testFiles: [file], refreshRate: 75 })).rejects.toThrow(
      "refresh rate",
    );
  });
});
