import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { clearTimeout as cancelTimer, setTimeout as scheduleTimer } from "node:timers";

import { validTimingContract } from "./performance-comparison.mjs";

const PREFIX = "INKBOOK_TIMING_RECORDS ";
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

function validateMeasurement(record, context) {
  if (!record || typeof record !== "object") throw new Error("Invalid timing measurement.");
  const valid =
    typeof record.testName === "string" &&
    record.testName.length > 0 &&
    Number.isInteger(record.ordinal) &&
    record.ordinal > 0 &&
    Number.isFinite(record.actualMs) &&
    record.actualMs >= 0 &&
    validTimingContract(record) &&
    (record.comparison === "relative" || Number.isFinite(record.ratio)) &&
    record.refreshRate === context.refreshRate &&
    (record.label === undefined || typeof record.label === "string");
  if (!valid) throw new Error("Invalid timing measurement.");
  if (normalizeFile(context.root, record.testPath) !== context.file) {
    throw new Error("Measurement test path differs from envelope.");
  }
}

function parseMeasurements(stderr, context) {
  const remaining = new Set(context.files);
  const measurements = [];
  for (const line of stderr.split("\n").filter((entry) => entry.startsWith(PREFIX))) {
    const envelope = JSON.parse(line.slice(PREFIX.length));
    const file = consumeFile(context.root, envelope?.testPath, remaining);
    if (!Array.isArray(envelope.measurements) || envelope.measurements.length > 20_000) {
      throw new Error("Invalid timing measurement population.");
    }
    const ordinals = new Map();
    for (const record of envelope.measurements) {
      validateMeasurement(record, { ...context, file });
      const next = (ordinals.get(record.testName) ?? 0) + 1;
      if (record.ordinal !== next) throw new Error("Unexpected timing measurement ordinal.");
      ordinals.set(record.testName, next);
      measurements.push({ ...record, file });
    }
  }
  assertComplete(remaining, "timing envelopes");
  return measurements;
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

export function parseBatchReport({ root, testFiles, refreshRate, stdout, stderr }) {
  if (!REFRESH_RATES.includes(refreshRate)) throw new Error("Unsupported refresh rate.");
  const files = expectedFiles(root, testFiles);
  const context = { root, files, refreshRate };
  const violations = parseTestResults(stdout, context);
  const measurements = parseMeasurements(stderr, context);
  return { files, measurements, violations };
}

function spawnBatch({ root, files, refreshRate, mode }) {
  const env = {
    ...process.env,
    INKBOOK_PERFORMANCE_MODE: mode,
    INKBOOK_PERFORMANCE_REPORT: "1",
    INKBOOK_PERFORMANCE_REFRESH_RATE: String(refreshRate),
  };
  delete env.INKBOOK_PERFORMANCE_PROFILE;
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
      ...(mode === "measurement" ? ["--cache=false"] : []),
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
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

export async function runPerformanceBatch({ root, testFiles, refreshRate, mode, reportDirectory }) {
  if (!["contracts", "reference", "measurement"].includes(mode))
    throw new Error("Unsupported performance mode.");
  if (!REFRESH_RATES.includes(refreshRate)) throw new Error("Unsupported refresh rate.");
  const files = expectedFiles(root, testFiles);
  const startedAt = performance.now();
  const captured = await captureBatch(spawnBatch({ root, files, refreshRate, mode }));
  let result = { files, measurements: [], violations: [] };
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
  result.durationMs = performance.now() - startedAt;
  if (reportDirectory) {
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(join(reportDirectory, "batch.json"), JSON.stringify(result, null, 2) + "\n");
  }
  return result;
}
