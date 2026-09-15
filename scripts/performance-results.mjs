import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";

const PREFIX = "INKBOOK_TIMING_RECORDS ";
const MAX_RECORDS = 20_000;

export function parseTimingRecords(stderr) {
  const lines = stderr.split("\n").filter((line) => line.startsWith(PREFIX));
  if (lines.length !== 1) throw new Error("Expected exactly one timing report per test file.");
  const records = JSON.parse(lines[0].slice(PREFIX.length));
  if (!Array.isArray(records) || records.length > MAX_RECORDS) {
    throw new Error("Invalid timing report size.");
  }
  for (const record of records) {
    if (!validTimingRecord(record)) throw new Error("Invalid timing measurement.");
  }
  return records;
}

function validTimingRecord(record) {
  return (
    record !== null &&
    typeof record === "object" &&
    typeof record.testName === "string" &&
    typeof record.testPath === "string" &&
    Number.isInteger(record.ordinal) &&
    record.ordinal > 0 &&
    Number.isFinite(record.actualMs) &&
    record.actualMs >= 0 &&
    Number.isFinite(record.referenceMs) &&
    record.referenceMs > 0 &&
    Number.isFinite(record.limitMs) &&
    record.limitMs > 0 &&
    Number.isFinite(record.ratio) &&
    record.ratio === record.actualMs / record.referenceMs &&
    [60, 90, 120, 144, 240].includes(record.refreshRate) &&
    ["lt", "lte"].includes(record.comparison)
  );
}

export async function createPerformanceResults(projectRoot, runs) {
  if (process.env["INKBOOK_PERFORMANCE_REPORT"] !== "1") return undefined;
  const directory = process.env["INKBOOK_PERFORMANCE_RESULTS_DIR"];
  if (!directory) throw new Error("Timing reports require INKBOOK_PERFORMANCE_RESULTS_DIR.");
  await mkdir(directory, { recursive: true });
  const cpu = cpus();
  const git = (...args) => execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" }).trim();
  const metadata = {
    commit: git("rev-parse", "HEAD"),
    sourceTree: git("rev-parse", "HEAD:src"),
    dirty: git("status", "--porcelain").length > 0,
    lockSha256: createHash("sha256")
      .update(await readFile(join(projectRoot, "package-lock.json")))
      .digest("hex"),
    node: process.version,
    platform: platform(),
    release: release(),
    cpuModel: cpu[0]?.model,
    logicalCpus: cpu.length,
    availableParallelism: availableParallelism(),
    memoryBytes: totalmem(),
    image: process.env["ImageOS"],
    imageVersion: process.env["ImageVersion"],
    runId: process.env["GITHUB_RUN_ID"],
    runAttempt: process.env["GITHUB_RUN_ATTEMPT"],
    profile: process.env["INKBOOK_PERFORMANCE_PROFILE"] ?? "reference",
    startedAt: new Date().toISOString(),
    plan: runs.map(({ label, refreshRate, testFiles }) => ({
      label,
      refreshRate,
      files: testFiles.length,
    })),
  };
  await writeFile(join(directory, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  const results = [];
  return async (result) => {
    results.push(result);
    await writeFile(join(directory, "measurements.json"), JSON.stringify(results, null, 2) + "\n");
  };
}
