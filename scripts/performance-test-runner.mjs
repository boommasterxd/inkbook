import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("..", import.meta.url));
export const performanceRoot = join(projectRoot, "test", "performance");

const vitestEntry = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));

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

export async function runRefreshRateMatrix(testFiles, refreshRates, options = {}) {
  if (testFiles.length === 0) throw new Error("No performance test files were selected.");
  const failFast = options.failFast ?? false;
  const violations = [];
  for (const refreshRate of refreshRates) {
    process.stdout.write(`\nRunning complete performance suite at ${refreshRate} Hz...\n`);
    for (const testFile of testFiles) {
      const result = await runTestFile(testFile, refreshRate);
      const label = relative(projectRoot, testFile);
      process.stdout.write(`  ${result.length === 0 ? "PASS" : "FAIL"} ${label}\n`);
      violations.push(...result);
      if (failFast && result.length > 0) return violations;
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
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      [
        "--expose-gc",
        vitestEntry,
        "run",
        relativeTestFile,
        "--reporter=json",
        "--fileParallelism=false",
      ],
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
      resolve([fileViolation(refreshRate, relativeTestFile, "Test process", error.message)]);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve([]);
        return;
      }
      resolve(
        parseViolations(
          stdout,
          refreshRate,
          relativeTestFile,
          signal ?? `exit code ${code}`,
          stderr,
        ),
      );
    });
  });
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
