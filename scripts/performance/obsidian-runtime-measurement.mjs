import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  loadArtifactBudget,
  measureArtifactPackage,
} from "./artifact-budget.mjs";
import { CdpSession, discoverCdpTarget } from "./cdp-session.mjs";
import { runAsCli } from "./cli.mjs";
import { ObsidianRuntimeHost } from "./obsidian-runtime-host.mjs";
import { validateProfile } from "./performance-profile.mjs";
import { stableJson } from "./schema-validation.mjs";

const EXPECTED_WARMUPS = 5;
const EXPECTED_SAMPLES = 100;
const MAX_HEAP_SAMPLES_PER_CYCLE = 2_048;
const MEBIBYTE = 1_048_576;
const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";
const DEFAULT_TIMEOUT_MS = 10_000;
const PLUGIN_ID = "inkbook";

export class RuntimeMeasurementError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeMeasurementError";
  }
}

function fail(message) {
  throw new RuntimeMeasurementError(message);
}

function rounded(value) {
  return Number(value.toFixed(6));
}

function nearestRank(sorted, percentile) {
  const index = Math.ceil(percentile * sorted.length) - 1;
  return sorted[index];
}

export function summarizeMeasurements(values) {
  if (
    values.length !== EXPECTED_SAMPLES ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    fail("Runtime statistics require exactly 100 finite non-negative samples");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    maximum: rounded(sorted.at(-1)),
    p50: rounded(nearestRank(sorted, 0.5)),
    p95: rounded(nearestRank(sorted, 0.95)),
    p99: rounded(nearestRank(sorted, 0.99)),
    variance: rounded(variance),
  };
}

function assertMarkBoundary(enableStartedAt, previousModuleEvaluatedAt, ready) {
  if (
    ready.moduleEvaluatedAt < enableStartedAt ||
    ready.moduleEvaluatedAt <= previousModuleEvaluatedAt ||
    ready.moduleEvaluatedAt > ready.onloadEnteredAt ||
    ready.onloadEnteredAt < enableStartedAt ||
    ready.onloadSettledAt < ready.onloadEnteredAt
  ) {
    fail("Runtime marks do not belong to the current enable boundary");
  }
  return ready;
}

async function collectCycle(driver, previousModuleEvaluatedAt) {
  const disabled = await driver.disableCurrent(previousModuleEvaluatedAt);
  if (
    disabled.resourceCoordinatorBalanced !== true ||
    disabled.resourceCoordinatorDisposed !== true
  ) {
    fail("Disposal did not prove a balanced disposed resource coordinator");
  }
  await driver.collectGarbage();
  const baseline = await driver.heapUsage();
  let outcome;
  void driver.enableNext(previousModuleEvaluatedAt).then(
    (value) => {
      outcome = { value };
    },
    (error) => {
      outcome = { error };
    },
  );
  const heapSamples = [baseline.usedSize];
  while (outcome === undefined) {
    if (heapSamples.length >= MAX_HEAP_SAMPLES_PER_CYCLE) {
      fail("Heap sampling limit reached before onload settled");
    }
    heapSamples.push((await driver.heapUsage()).usedSize);
  }
  if (outcome.error) throw outcome.error;
  heapSamples.push((await driver.heapUsage()).usedSize);
  const enabled = outcome.value;
  const marks = assertMarkBoundary(
    enabled.enableStartedAt,
    previousModuleEvaluatedAt,
    enabled.ready,
  );
  const peak = Math.max(...heapSamples);
  return {
    moduleEvaluatedAt: marks.moduleEvaluatedAt,
    moduleCssMs: marks.onloadEnteredAt - enabled.enableStartedAt,
    onloadMs: marks.onloadSettledAt - enabled.enableStartedAt,
    peakAdditionalHeapMiB: Math.max(0, peak - baseline.usedSize) / MEBIBYTE,
    zeroBalanceDisposal: true,
  };
}

function measuredRow(profile, rowId, cellId, values) {
  const row = profile.rows.find((candidate) => candidate.id === rowId);
  const threshold = row?.thresholds[cellId];
  if (!row || row.kind !== "runtime" || !threshold) {
    fail(`Profile is missing runtime row ${rowId}/${cellId}`);
  }
  const statistics = summarizeMeasurements(values);
  const selectedValue =
    threshold.p95Max === undefined ? statistics.maximum : statistics.p95;
  const selectedLimit = threshold.p95Max ?? threshold.max;
  if (selectedLimit !== undefined && selectedValue > selectedLimit) {
    fail(`${rowId}/${cellId} exceeds its frozen threshold`);
  }
  if (threshold.required === true && statistics.maximum !== 1) {
    fail(`${rowId}/${cellId} did not satisfy its required lifecycle assertion`);
  }
  return {
    metric: row.metric,
    rowId,
    unit: row.unit,
    warmups: row.warmups,
    samples: row.samples,
    thresholds: { ...threshold },
    ...statistics,
    pass: true,
  };
}

function assertionRow(profile, rowId, cellId, passed) {
  const row = profile.rows.find((candidate) => candidate.id === rowId);
  const threshold = row?.thresholds[cellId];
  if (
    !row ||
    row.kind !== "assertion" ||
    row.warmups !== 0 ||
    row.samples !== 1 ||
    threshold?.required !== true ||
    passed !== true
  ) {
    fail(`Profile assertion ${rowId}/${cellId} is missing or failed`);
  }
  return {
    metric: row.metric,
    rowId,
    unit: row.unit,
    warmups: 0,
    samples: 1,
    thresholds: { ...threshold },
    maximum: 1,
    p50: 1,
    p95: 1,
    p99: 1,
    variance: 0,
    pass: true,
  };
}

function buildOutput(profile, cell, cycles, environment) {
  const numeric = (key) => cycles.map((cycle) => cycle[key]);
  const workerPassed =
    environment.workerLaunched === true &&
    environment.workerResultPassed === true &&
    environment.recoveryPassed === true &&
    environment.workerResourcesReleased === true;
  const disposalPassed = cycles.every(
    (cycle) => cycle.zeroBalanceDisposal === true,
  );
  return {
    schema: "InkbookRuntimeMeasurementV1",
    version: 1,
    profileId: profile.profileId,
    profileVersion: profile.version,
    procedureVersion: profile.procedure.version,
    artifact: {
      mainJsSha256: profile.artifact.mainJsSha256,
      stylesCssSha256: profile.artifact.stylesCssSha256,
    },
    cell: {
      id: cell.id,
      host: cell.host,
      os: cell.os,
      device: cell.device,
      refreshRateHz: cell.refreshRateHz,
      budgetClass: cell.budgetClass,
    },
    rows: [
      measuredRow(
        profile,
        "P0-COLD-MODULE-EVAL-P95",
        cell.id,
        numeric("moduleCssMs"),
      ),
      measuredRow(profile, "P0-COLD-ONLOAD-P95", cell.id, numeric("onloadMs")),
      measuredRow(
        profile,
        "P0-COLD-PEAK-HEAP",
        cell.id,
        numeric("peakAdditionalHeapMiB"),
      ),
      assertionRow(
        profile,
        "P0-WORKER-RESIDENT-OWNERSHIP",
        cell.id,
        workerPassed,
      ),
      assertionRow(
        profile,
        "P0-ZERO-BALANCE-DISPOSAL",
        cell.id,
        disposalPassed,
      ),
    ],
  };
}

export async function measureRuntimeCell({ driver, profile, cellId }) {
  if (
    profile.status !== "final" ||
    profile.procedure.warmups !== EXPECTED_WARMUPS ||
    profile.procedure.samples !== EXPECTED_SAMPLES ||
    profile.procedure.percentile !== "nearest-rank"
  ) {
    fail(
      "Runtime measurement requires the final frozen 5/100 nearest-rank profile",
    );
  }
  const cell = profile.cells.find((candidate) => candidate.id === cellId);
  if (!cell) fail(`Unknown performance cell ${cellId}`);
  let current = await driver.initialize();
  const environment = await driver.runEnvironmentProbe();
  let mutated = false;
  const samples = [];
  try {
    for (
      let index = 0;
      index < EXPECTED_WARMUPS + EXPECTED_SAMPLES;
      index += 1
    ) {
      mutated = true;
      const cycle = await collectCycle(driver, current.moduleEvaluatedAt);
      current = { moduleEvaluatedAt: cycle.moduleEvaluatedAt };
      if (index >= EXPECTED_WARMUPS) samples.push(cycle);
    }
  } catch (error) {
    if (mutated) {
      try {
        await driver.ensureEnabled();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Measurement and cleanup failed",
          {
            cause: cleanupError,
          },
        );
      }
    }
    throw error;
  }
  return buildOutput(profile, cell, samples, environment);
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`Missing value for ${name}`);
  return value;
}

function assertKnownOptions(args) {
  const known = new Set([
    "--endpoint",
    "--target-id",
    "--profile",
    "--package",
    "--cell",
    "--timeout-ms",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index]) || !args[index + 1])
      fail(`Unknown or incomplete option ${args[index] ?? ""}`);
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail(`Cannot read JSON ${filePath}: ${error.message}`);
  }
}

export async function main(args = process.argv.slice(2)) {
  assertKnownOptions(args);
  const endpoint = option(args, "--endpoint", DEFAULT_ENDPOINT);
  const targetId = option(args, "--target-id");
  const profilePath = option(
    args,
    "--profile",
    "config/performance-profile.v1.json",
  );
  const packageDirectory = option(args, "--package", "dist");
  const cellId = option(args, "--cell");
  const timeoutMs = Number(
    option(args, "--timeout-ms", String(DEFAULT_TIMEOUT_MS)),
  );
  if (!cellId) fail("--cell is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    fail("--timeout-ms must be an integer from 1000 through 30000");
  }
  const [profile, budget, artifact] = await Promise.all([
    readJson(profilePath),
    loadArtifactBudget(),
    measureArtifactPackage(path.resolve(packageDirectory)),
  ]);
  validateProfile(profile, { artifact, budget });
  const target = await discoverCdpTarget({ endpoint, targetId, timeoutMs });
  const session = await CdpSession.connect(target.webSocketDebuggerUrl, {
    timeoutMs,
  });
  try {
    const driver = new ObsidianRuntimeHost(session, {
      pluginId: PLUGIN_ID,
      environmentProbeCommandId: "inkbook:phase-zero-run-environment-probe",
      markTimeoutMs: Math.max(1_000, timeoutMs - 250),
    });
    const output = await measureRuntimeCell({ driver, profile, cellId });
    process.stdout.write(`${stableJson(output)}\n`);
    return output;
  } finally {
    session.close();
  }
}

runAsCli(import.meta.url, main);
