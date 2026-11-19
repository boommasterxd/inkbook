import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const timers = vi.hoisted(() => ({ setTimeout: vi.fn(), clearTimeout: vi.fn() }));
vi.mock("node:timers", () => timers);
vi.mock("../../../scripts/check-execution.mjs", () => ({
  forwardSignal: vi.fn(),
  waitForShutdown: vi.fn(async () => true),
}));
import { spawn } from "node:child_process";
import { forwardSignal, waitForShutdown } from "../../../scripts/check-execution.mjs";
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
  vi.mocked(forwardSignal).mockImplementation(() => {
    child.emit("close", null, "SIGKILL");
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
    expect(options.detached).toBe(process.platform !== "win32");
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
    expect(forwardSignal).toHaveBeenCalledWith(child, "SIGKILL");
    expect((await pending).violations).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("20 minutes") }),
    );
    expect(waitForShutdown).toHaveBeenCalledWith(child, expect.any(Number));
  });

  it("stops the gate when termination cannot be verified", async () => {
    mockChild();
    vi.mocked(waitForShutdown).mockResolvedValueOnce(false);
    const pending = runPerformanceBatch({ root, testFiles: [file], refreshRate: 240 });
    const [onTimeout] = timers.setTimeout.mock.calls[0];
    onTimeout();
    await expect(pending).rejects.toThrow(
      "Performance process group shutdown could not be verified",
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
    child.emit("close", -1, null);
    expect((await pending).violations).toContainEqual(
      expect.objectContaining({ message: "spawn failed" }),
    );
    await expect(runPerformanceBatch({ root, testFiles: [file], refreshRate: 75 })).rejects.toThrow(
      "refresh rate",
    );
  });
});

async function readWorkerState(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return undefined;
    throw error;
  }
}

async function performanceRunner(scenario, directory, realSpawn) {
  const scripts = join(directory, "node_modules", "vitest");
  await mkdir(scripts, { recursive: true });
  await writeFile(
    join(scripts, "vitest.mjs"),
    `
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
spawn(process.execPath, ["-e",
  'const fs = require("node:fs"); fs.writeFileSync("worker.pid", String(process.pid)); setTimeout(() => process.exit(), 5000);'
], { stdio: "ignore" });
if (process.env.TEST_SCENARIO === "overflow") {
  const chunk = "a".repeat(1024 * 1024);
  const timer = setInterval(() => {
    if (!existsSync("worker.pid")) return;
    clearInterval(timer);
    for (let index = 0; index <= 32; index++) process.stdout.write(chunk);
  }, 10);
}
`,
  );
  const module = new URL("../../../scripts/performance-batch.mjs", import.meta.url).href;
  return realSpawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { runPerformanceBatch } from ${JSON.stringify(module)};
try {
  const result = await runPerformanceBatch({ root: process.cwd(), testFiles: ${JSON.stringify([file])}, refreshRate: 120 });
  process.stderr.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error.message);
  process.exitCode = 1;
}`,
    ],
    {
      cwd: directory,
      env: { ...process.env, TEST_SCENARIO: scenario },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
}

if (process.platform === "linux") {
  it.each(["overflow", "interrupt"])("stops an owned worker process on %s", async (scenario) => {
    const { spawn: realSpawn } = await vi.importActual("node:child_process");
    const directory = await mkdtemp(join(tmpdir(), "inkbook-performance-batch-"));
    let runner;
    let workerPid;
    try {
      runner = await performanceRunner(scenario, directory, realSpawn);
      let diagnostic = "";
      runner.stderr.setEncoding("utf8");
      runner.stderr.on("data", (chunk) => (diagnostic += chunk));
      const closed = new Promise((resolve, reject) => {
        runner.once("close", resolve);
        runner.once("error", reject);
      });
      workerPid = await vi.waitFor(async () =>
        Number(await readFile(join(directory, "worker.pid"), "utf8")),
      );
      if (scenario === "interrupt") runner.kill("SIGTERM");
      expect(await closed).toBe(scenario === "interrupt" ? 1 : 0);
      expect(diagnostic).toContain(scenario === "interrupt" ? "interrupted (SIGTERM)" : "32 MiB");
      expect([undefined, "Z", "X"]).toContain(await readWorkerState(workerPid));
    } finally {
      if (runner?.exitCode === null) runner.kill("SIGTERM");
      if (workerPid && ![undefined, "Z", "X"].includes(await readWorkerState(workerPid))) {
        process.kill(workerPid, "SIGKILL");
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
