import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { PERFORMANCE_TEST_MANIFEST } from "./performance-test-manifest.mjs";

export const projectRoot = fileURLToPath(new URL("..", import.meta.url));
export const performanceRoot = join(projectRoot, "test", "performance");

const vitestEntry = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));

export const SUPPORTED_REFRESH_RATES = Object.freeze([60, 90, 120, 144, 240]);
export const DEFAULT_REFRESH_RATE = 120;
export const STRICTEST_REFRESH_RATE = 240;

export async function collectTestFiles(directory = performanceRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTestFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files.sort();
}

export async function collectPerformanceTestPlan(directory = performanceRoot) {
  return createPerformanceTestPlan(await collectTestFiles(directory));
}

export function createPerformanceTestPlan(testFiles) {
  const discovered = new Map(
    testFiles.map((testFile) => [relative(projectRoot, testFile).replaceAll("\\", "/"), testFile]),
  );
  const classified = new Set();
  const plan = {};
  for (const [category, manifestFiles] of Object.entries(PERFORMANCE_TEST_MANIFEST)) {
    plan[category] = manifestFiles.map((manifestFile) => {
      if (classified.has(manifestFile)) {
        throw new Error(`Performance test is classified more than once: ${manifestFile}`);
      }
      classified.add(manifestFile);
      const discoveredFile = discovered.get(manifestFile);
      if (discoveredFile === undefined) {
        throw new Error(`Classified performance test was not found: ${manifestFile}`);
      }
      return discoveredFile;
    });
  }
  const unclassified = [...discovered.keys()].filter((testFile) => !classified.has(testFile));
  if (unclassified.length > 0) {
    throw new Error(`Unclassified performance tests:\n${unclassified.join("\n")}`);
  }
  return Object.freeze(plan);
}

export function selectPerformanceRuns(plan, suite, configuredRefreshRate) {
  if (suite === "shared") {
    return [
      {
        label: "refresh-rate-invariant",
        refreshRate: DEFAULT_REFRESH_RATE,
        testFiles: plan.invariant,
      },
      { label: "budget-only", refreshRate: STRICTEST_REFRESH_RATE, testFiles: plan.budgetOnly },
    ];
  }
  if (suite === "profile") {
    const refreshRate = parseRefreshRate(configuredRefreshRate);
    return [{ label: "cadence-sensitive", refreshRate, testFiles: plan.cadenceSensitive }];
  }
  if (suite === "cadence") {
    return SUPPORTED_REFRESH_RATES.map((refreshRate) => ({
      label: "cadence-sensitive",
      refreshRate,
      testFiles: plan.cadenceSensitive,
    }));
  }
  if (suite !== "all") throw new TypeError(`Unsupported performance suite: ${suite}`);
  return [...selectPerformanceRuns(plan, "shared"), ...selectPerformanceRuns(plan, "cadence")];
}

export async function runPerformanceRuns(runs, options = {}) {
  const failFast = options.failFast ?? false;
  const violations = [];
  for (const run of runs) {
    process.stdout.write(`\nRunning ${run.label} performance suite at ${run.refreshRate} Hz...\n`);
    for (const testFile of run.testFiles) {
      const result = await runTestFile(testFile, run.refreshRate);
      const label = relative(projectRoot, testFile);
      process.stdout.write(
        `  ${result.violations.length === 0 ? "PASS" : "FAIL"} ${label} ` +
          `(${(result.durationMs / 1_000).toFixed(1)}s)\n`,
      );
      violations.push(...result.violations);
      if (failFast && result.violations.length > 0) return violations;
    }
  }
  return violations;
}

export function reportPerformanceViolations(violations) {
  if (violations.length === 0) {
    process.stdout.write("\nAll refresh-rate performance profiles passed.\n");
    return;
  }
  process.stderr.write(`\nRefresh-rate performance violations (${violations.length}):\n`);
  for (const violation of violations) {
    process.stderr.write(`\n- [${violation.refreshRate} Hz] ${violation.file}\n`);
    process.stderr.write(`  ${violation.test}\n`);
    process.stderr.write(`  ${violation.message}\n`);
  }
}

function runTestFile(testFile, refreshRate) {
  const relativeTestFile = relative(projectRoot, testFile);
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      ["--expose-gc", vitestEntry, "run", relativeTestFile, "--fileParallelism=false"],
      {
        cwd: projectRoot,
        env: { ...process.env, INKBOOK_PERFORMANCE_REFRESH_RATE: String(refreshRate) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      resolve({
        durationMs: performance.now() - startedAt,
        violations: [fileViolation(refreshRate, relativeTestFile, "Test process", error.message)],
      });
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ durationMs: performance.now() - startedAt, violations: [] });
        return;
      }
      resolve({
        durationMs: performance.now() - startedAt,
        violations: parseViolations(
          stdout,
          refreshRate,
          relativeTestFile,
          signal ?? `exit code ${code}`,
          stderr,
        ),
      });
    });
  });
}

function parseRefreshRate(configuredRefreshRate) {
  const candidate = Number(configuredRefreshRate);
  const refreshRate = SUPPORTED_REFRESH_RATES.find((value) => value === candidate);
  if (refreshRate === undefined) {
    throw new TypeError(`Unsupported performance refresh rate: ${String(configuredRefreshRate)}`);
  }
  return refreshRate;
}

function parseViolations(rawReport, refreshRate, file, exitReason, stderr) {
  try {
    const report = JSON.parse(rawReport);
    const violations = [];
    for (const result of report.testResults ?? []) {
      for (const assertion of result.assertionResults ?? []) {
        if (assertion.status !== "failed") continue;
        violations.push(
          fileViolation(
            refreshRate,
            file,
            assertion.fullName ?? assertion.title ?? "Unknown test",
            firstFailureLine(assertion.failureMessages?.[0]),
          ),
        );
      }
      if (result.status === "failed" && (result.assertionResults?.length ?? 0) === 0) {
        violations.push(
          fileViolation(
            refreshRate,
            file,
            result.name ?? "Test file",
            firstFailureLine(result.message),
          ),
        );
      }
    }
    if (violations.length > 0) return violations;
  } catch {
    // The file-level diagnostic below retains malformed or interrupted reporter output.
  }
  const diagnostic = firstFailureLine(stderr) || `Vitest failed with ${exitReason}.`;
  return [fileViolation(refreshRate, file, "Test file", diagnostic)];
}

function fileViolation(refreshRate, file, test, message) {
  return { file, message, refreshRate, test };
}

function firstFailureLine(message) {
  return (
    message
      ?.split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "Unknown failure."
  );
}
