import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { executePerformanceGate } from "./performance-gate.mjs";

import { PERFORMANCE_TEST_MANIFEST } from "./performance-test-manifest.mjs";

export const projectRoot = fileURLToPath(new URL("..", import.meta.url));
export const performanceRoot = join(projectRoot, "test", "performance");

export const SUPPORTED_REFRESH_RATES = Object.freeze([60, 90, 120, 144, 240]);
export const DEFAULT_REFRESH_RATE = 120;

export function assertFullPerformanceEnvironment(environment = process.env) {
  if (
    (environment["INKBOOK_PERFORMANCE_SUITE"] ?? "all") !== "all" ||
    environment["INKBOOK_PERFORMANCE_REFRESH_RATE"] !== undefined
  ) {
    throw new Error("Full performance checks require suite all; unset shard overrides.");
  }
}

export async function collectTestFiles(directory = performanceRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTestFiles(path)));
    else if (entry.isFile() && /\.test\.(?:ts|tsx|mjs)$/.test(entry.name)) files.push(path);
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

function invariantRun(testFiles) {
  return { label: "refresh-rate-invariant", refreshRate: DEFAULT_REFRESH_RATE, testFiles };
}

function cadenceRuns(plan) {
  return SUPPORTED_REFRESH_RATES.map((refreshRate) => ({
    label: "cadence-sensitive",
    refreshRate,
    testFiles: plan.cadenceSensitive,
  }));
}

export function selectPerformanceRuns(plan, suite, configuredRefreshRate) {
  if (suite === "shared") return [invariantRun(plan.invariant)];
  if (suite === "profile") {
    const refreshRate = parseRefreshRate(configuredRefreshRate);
    return [{ label: "cadence-sensitive", refreshRate, testFiles: plan.cadenceSensitive }];
  }
  if (suite === "cadence") {
    return cadenceRuns(plan);
  }
  if (suite !== "all") throw new TypeError(`Unsupported performance suite: ${suite}`);
  return [invariantRun(plan.invariant), ...cadenceRuns(plan)];
}

export async function runPerformanceRuns(runs) {
  return executePerformanceGate(projectRoot, runs);
}

export function reportPerformanceViolations(violations) {
  if (violations.length === 0) {
    process.stdout.write("\nDeterministic performance contracts passed.\n");
    return;
  }
  process.stderr.write(`\nRefresh-rate performance violations (${violations.length}):\n`);
  for (const violation of violations) {
    process.stderr.write(`\n- [${violation.refreshRate} Hz] ${violation.file}\n`);
    process.stderr.write(`  ${violation.test}\n`);
    process.stderr.write(`  ${violation.message}\n`);
  }
}

function parseRefreshRate(configuredRefreshRate) {
  const candidate = Number(configuredRefreshRate);
  const refreshRate = SUPPORTED_REFRESH_RATES.find((value) => value === candidate);
  if (refreshRate === undefined) {
    throw new TypeError(`Unsupported performance refresh rate: ${String(configuredRefreshRate)}`);
  }
  return refreshRate;
}
