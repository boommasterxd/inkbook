import { spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { clearTimeout as cancelTimer, setTimeout as scheduleTimer } from "node:timers";

const OUTPUT_LIMIT = 32 * 1024 * 1024;
const DURATION_LIMIT = 20 * 60 * 1000;
const REFRESH_RATES = [60, 90, 120, 144, 240];

function normalizeFile(root, file) {
  if (typeof file !== "string" || file.length === 0) throw new Error("Invalid test path.");
  const normalized = relative(resolve(root), resolve(root, file));
  if (normalized === "" || normalized.startsWith("..") || isAbsolute(normalized)) {
    throw new Error("Test path escapes the workspace.");
  }
  return normalized.replaceAll("\\", "/");
}

function expectedFiles(root, testFiles) {
  if (!Array.isArray(testFiles) || testFiles.length === 0) throw new Error("Empty test batch.");
  const files = testFiles.map((file) => normalizeFile(root, file));
  if (new Set(files).size !== files.length) throw new Error("Duplicate expected test file.");
  return files.toSorted();
}

function consumeFile(root, path, remaining) {
  const file = normalizeFile(root, path);
  if (!remaining.delete(file)) throw new Error(`Unexpected or duplicate test file: ${file}.`);
  return file;
}

function assertComplete(remaining, kind) {
  if (remaining.size > 0) throw new Error(`Missing ${kind}: ${[...remaining].join(", ")}.`);
}

function parseTestResults(stdout, context) {
  const report = JSON.parse(stdout);
  if (!Array.isArray(report.testResults)) throw new Error("Missing Vitest test results.");
  const remaining = new Set(context.files);
  const violations = [];
  for (const result of report.testResults) {
    const file = consumeFile(context.root, result.name, remaining);
    if (!Array.isArray(result.assertionResults) || result.assertionResults.length === 0) {
      throw new Error(`No test assertions for ${file}.`);
    }
    for (const assertion of result.assertionResults) {
      if (assertion.status !== "passed") {
        violations.push({
          file,
          test: assertion.fullName ?? assertion.title ?? "Unknown test",
          message: assertion.failureMessages?.[0] ?? `Test status: ${assertion.status}`,
          refreshRate: context.refreshRate,
        });
      }
    }
    if (result.status !== "passed") {
      violations.push({
        file,
        test: "Test file",
        message: result.message || `File status: ${result.status}`,
        refreshRate: context.refreshRate,
      });
    }
  }
  assertComplete(remaining, "Vitest results");
  if (report.success !== true && violations.length === 0) {
    throw new Error("Vitest did not report a successful batch.");
  }
  return violations;
}

export function parseBatchReport({ root, testFiles, refreshRate, stdout }) {
  if (!REFRESH_RATES.includes(refreshRate)) throw new Error("Unsupported refresh rate.");
  const files = expectedFiles(root, testFiles);
  const violations = parseTestResults(stdout, { root, files, refreshRate });
  return { files, violations };
}

function spawnBatch({ root, files, refreshRate }) {
  return spawn(
    process.execPath,
    [
      "--expose-gc",
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      ...files,
      "--fileParallelism=false",
      "--maxWorkers=1",
      "--isolate",
      "--reporter=json",
    ],
    {
      cwd: root,
      env: { ...process.env, INKBOOK_PERFORMANCE_REFRESH_RATE: String(refreshRate) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function captureBatch(child) {
  return new Promise((complete) => {
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure;
    const terminate = (message) => {
      failure ??= message;
      child.kill("SIGKILL");
    };
    const timeout = scheduleTimer(
      () => terminate("Performance batch exceeded 20 minutes."),
      DURATION_LIMIT,
    );
    const append = (destination, chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > OUTPUT_LIMIT) {
        terminate("Performance batch output exceeded 32 MiB.");
        return;
      }
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.once("error", (error) => {
      cancelTimer(timeout);
      complete({ stdout, stderr, failure: error.message });
    });
    child.once("close", (code, signal) => {
      cancelTimer(timeout);
      complete({
        stdout,
        stderr,
        failure: failure ?? (code === 0 ? undefined : `Vitest exited with ${signal ?? code}.`),
      });
    });
  });
}

export async function runPerformanceBatch({ root, testFiles, refreshRate }) {
  if (!REFRESH_RATES.includes(refreshRate)) throw new Error("Unsupported refresh rate.");
  const files = expectedFiles(root, testFiles);
  const captured = await captureBatch(spawnBatch({ root, files, refreshRate }));
  let result = { files, violations: [] };
  try {
    result = parseBatchReport({ root, testFiles, refreshRate, ...captured });
  } catch (error) {
    result.violations.push({
      file: files.join(", "),
      test: "Batch report",
      message: error.message,
      refreshRate,
    });
  }
  if (captured.failure) {
    result.violations.push({
      file: files.join(", "),
      test: "Test process",
      message: captured.failure,
      refreshRate,
    });
  }
  return result;
}
