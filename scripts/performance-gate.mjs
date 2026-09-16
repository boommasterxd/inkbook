import { randomInt } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runPerformanceBatch } from "./performance-batch.mjs";
import { planPerformanceInputs } from "./performance-inputs.mjs";
import { TIMING_PERFORMANCE_FILES } from "./performance-test-manifest.mjs";
import { COMPARISON_STAGES, compareTimingRounds } from "./performance-comparison.mjs";
import { preparePerformanceWorkspaces, resolveLocalBaseline } from "./performance-workspace.mjs";
import { createBaselineReport } from "./performance-baseline-report.mjs";

export async function executePerformanceGate(projectRoot, runs) {
  if (!Array.isArray(runs) || runs.length === 0)
    throw new Error("Empty performance execution plan.");
  const mode = process.env["INKBOOK_PERFORMANCE_MODE"] ?? "gate";
  if (!["gate", "contracts", "reference"].includes(mode)) {
    throw new Error(`Unsupported benchmark execution mode: ${mode}`);
  }
  if (process.env["INKBOOK_PERFORMANCE_PROFILE"] !== undefined) {
    throw new Error("Hardware timing multipliers are no longer supported.");
  }
  if (process.env["CI"] === "true" && mode !== "gate") {
    throw new Error("A diagnostic cannot replace the complete CI gate.");
  }
  if (mode !== "gate") return runDiagnostic(projectRoot, runs, mode);
  const policy = JSON.parse(await readFile(join(projectRoot, ".github/performance-policy.json")));
  const workspaces = await preparePerformanceWorkspaces(projectRoot, {
    base: process.env["INKBOOK_PERFORMANCE_BASE"] ?? "origin/main",
    anchor:
      process.env["INKBOOK_PERFORMANCE_ANCHOR"] ??
      resolveLocalBaseline(projectRoot, policy.anchorCommit),
  });
  let directory = process.env["INKBOOK_PERFORMANCE_RESULTS_DIR"];
  const report = { metadata: workspaces.metadata, batches: [], comparisons: [] };
  try {
    directory = directory
      ? resolve(directory)
      : await mkdtemp(join(tmpdir(), "inkbook-performance-"));
    workspaces.metadata.evidenceDirectory = directory;
    process.stdout.write(`Performance evidence: ${directory}\n`);
    const violations = await executeContracts(runs, workspaces, report);
    if (violations.length === 0) {
      violations.push(...(await executeComparisons(runs, workspaces, report)));
    }
    report.violations = violations;
    return violations;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    try {
      await saveReport(directory, report);
    } finally {
      await workspaces.dispose();
    }
  }
}

async function runDiagnostic(root, runs, mode) {
  const violations = [];
  process.stdout.write(`Explicit ${mode} measurement; this is not the relative CI gate.\n`);
  for (const run of runs) {
    const result = await runPerformanceBatch({ root, ...run, mode });
    violations.push(...result.violations);
  }
  return violations;
}

async function executeContracts(runs, workspaces, report) {
  const violations = [];
  for (const run of runs) {
    process.stdout.write(`\nContracts: ${run.label}, ${run.refreshRate} Hz\n`);
    const result = await runPerformanceBatch({
      root: workspaces.candidate.root,
      testFiles: run.testFiles.map((file) => relative(workspaces.metadata.projectRoot, file)),
      refreshRate: run.refreshRate,
      mode: "contracts",
    });
    const measuredFiles = new Set(result.measurements.map((measurement) => measurement.file));
    for (const file of result.files) {
      if (TIMING_PERFORMANCE_FILES.includes(file) !== measuredFiles.has(file)) {
        result.violations.push({
          file,
          test: "Timing coverage",
          refreshRate: run.refreshRate,
          message: "Timing population does not match the exhaustive manifest.",
        });
      }
    }
    report.batches.push({
      variant: "candidate",
      mode: "contracts",
      run: run.label,
      refreshRate: run.refreshRate,
      ...result,
    });
    violations.push(...result.violations);
    process.stdout.write(
      `  ${result.files.length} files, ${(result.durationMs / 1000).toFixed(1)}s\n`,
    );
  }
  return violations;
}

function evidencePath(workspaces, ...parts) {
  return join(workspaces.metadata.evidenceDirectory, ...parts);
}

async function executeComparisons(runs, workspaces, report) {
  const references = ["base", "anchor"].filter((variant) => {
    if (workspaces[variant].sourceHash !== workspaces.candidate.sourceHash) return true;
    report.comparisons.push({
      variant,
      status: "identical-source",
      sourceHash: workspaces[variant].sourceHash,
      reason: "Identical source and verified identical dependencies; no runtime change to time.",
    });
    return false;
  });
  if (references.length === 0) return [];
  const comparisons = new Map();
  const violations = [];
  for (const variant of references) {
    const sourceHash = workspaces[variant].sourceHash;
    let comparison = comparisons.get(sourceHash);
    if (!comparison) {
      comparison = await compareVariant(variant, runs, workspaces, report);
      comparisons.set(sourceHash, comparison);
    }
    report.comparisons.push({ variant, ...comparison });
    for (const metric of comparison.metrics.filter((value) => value.status !== "pass")) {
      violations.push({
        file: variant,
        test: metric.key,
        refreshRate: "comparison",
        message: `${metric.status}: observed paired ratios ${JSON.stringify(metric.ratios)}`,
      });
    }
  }
  return violations;
}

async function compareVariant(variant, runs, workspaces, report) {
  const plans = [];
  const inputPlans = new Map();
  for (const run of runs) {
    const testFiles = run.testFiles
      .map((file) => relative(workspaces.metadata.projectRoot, file))
      .filter((file) => TIMING_PERFORMANCE_FILES.includes(file))
      .sort();
    if (testFiles.length === 0) continue;
    const key = JSON.stringify(testFiles);
    let inputs = inputPlans.get(key);
    if (!inputs) {
      inputs = await planPerformanceInputs({
        referenceRoot: workspaces[variant].root,
        candidateRoot: workspaces.candidate.root,
        testFiles,
      });
      validateInputPlan(testFiles, inputs);
      inputPlans.set(key, inputs);
    }
    plans.push({ ...run, testFiles: inputs.pending, inputs });
  }
  const identicalInputs = plans.flatMap((plan) =>
    plan.inputs.identicalInputs.map((proof) => ({ ...proof, refreshRate: plan.refreshRate })),
  );
  const pending = plans.filter((plan) => plan.testFiles.length > 0);
  if (pending.length === 0) return { status: "identical-inputs", metrics: [], identicalInputs };
  const metrics = [];
  const orderPlans = [];
  for (const run of pending) {
    const result = await comparePlannedRun({ variant, run, workspaces, report });
    metrics.push(...result.metrics);
    orderPlans.push({ run: run.label, refreshRate: run.refreshRate, order: result.order });
  }
  const status = metrics.some((metric) => metric.status === "regression")
    ? "regression"
    : metrics.some((metric) => metric.status === "inconclusive")
      ? "inconclusive"
      : "pass";
  return {
    status,
    metrics,
    orderPlans,
    identicalInputs,
    inputs: plans.map(({ label, refreshRate, inputs }) => ({
      label,
      refreshRate,
      inputs: inputs.inputs,
    })),
  };
}

function comparisonOrder() {
  const order = [];
  let previous = 0;
  for (const stage of COMPARISON_STAGES) {
    const size = stage - previous;
    const block = Array.from({ length: size }, (_, index) =>
      index < size / 2 ? "reference" : "candidate",
    );
    for (let index = block.length - 1; index > 0; index -= 1) {
      const swap = randomInt(index + 1);
      [block[index], block[swap]] = [block[swap], block[index]];
    }
    order.push(...block);
    previous = stage;
  }
  return order;
}

async function comparePlannedRun({ variant, run, workspaces, report }) {
  const referenceRounds = [];
  const candidateRounds = [];
  const order = comparisonOrder();
  let comparison;
  let activeRun = run;
  let settledMetrics = [];
  for (let round = 0; round < order.length; round += 1) {
    const first = order[round];
    const sides = first === "reference" ? ["reference", "candidate"] : ["candidate", "reference"];
    const measurements = {};
    for (const side of sides) {
      const result = await measureOriginalBatch({
        variant,
        round,
        side,
        run: activeRun,
        workspaces,
        report,
      });
      measurements[side] = result.measurements;
    }
    referenceRounds.push(measurements.reference);
    candidateRounds.push(measurements.candidate);
    if (!COMPARISON_STAGES.includes(round + 1)) continue;
    comparison = compareTimingRounds(referenceRounds, candidateRounds);
    if (comparison.status !== "inconclusive") break;
    if (round + 1 === COMPARISON_STAGES[0]) {
      const unresolvedFiles = new Set(
        comparison.metrics
          .filter((metric) => metric.status === "inconclusive")
          .map((metric) => JSON.parse(metric.key)[0]),
      );
      settledMetrics = comparison.metrics.filter(
        (metric) => !unresolvedFiles.has(JSON.parse(metric.key)[0]),
      );
      activeRun = { ...run, testFiles: run.testFiles.filter((file) => unresolvedFiles.has(file)) };
      for (const rounds of [referenceRounds, candidateRounds]) {
        for (let index = 0; index < rounds.length; index += 1) {
          rounds[index] = rounds[index].filter((record) => unresolvedFiles.has(record.file));
        }
      }
    }
  }
  return { ...comparison, metrics: [...settledMetrics, ...comparison.metrics], order };
}

function validateInputPlan(files, plan) {
  if (!Array.isArray(plan?.pending) || !Array.isArray(plan?.identicalInputs)) {
    throw new Error("Missing original benchmark input plan.");
  }
  const remaining = new Set(files);
  for (const file of plan.pending) {
    if (!remaining.delete(file)) throw new Error("Unexpected or duplicate pending benchmark.");
  }
  for (const proof of plan.identicalInputs) {
    if (
      !remaining.delete(proof.file) ||
      !/^[a-f0-9]{64}$/.test(proof.inputHash ?? "") ||
      !Array.isArray(proof.inputs) ||
      proof.inputs.some((input) => typeof input !== "string" || !input)
    ) {
      throw new Error("Invalid identical benchmark input proof.");
    }
  }
  if (remaining.size > 0) throw new Error("Missing original benchmark input evidence.");
}

async function measureOriginalBatch({ variant, round, side, run, workspaces, report }) {
  const directory = evidencePath(
    workspaces,
    variant,
    String(round),
    run.label,
    String(run.refreshRate),
    side,
  );
  process.stdout.write(
    `\nOriginal benchmarks: ${variant}, round ${round + 1}, ${run.label}, ${side}\n`,
  );
  const result = await runPerformanceBatch({
    root: side === "candidate" ? workspaces.candidate.root : workspaces[variant].root,
    testFiles: run.testFiles,
    refreshRate: run.refreshRate,
    mode: "measurement",
    reportDirectory: directory,
  });
  report.batches.push({
    variant,
    mode: "measurement",
    side,
    round,
    run: run.label,
    refreshRate: run.refreshRate,
    measurementCount: result.measurements.length,
    durationMs: result.durationMs,
    artifact: join(directory, "batch.json"),
  });
  if (result.violations.length > 0)
    throw new Error(`Original benchmark failed: ${JSON.stringify(result.violations)}`);
  const remaining = new Set(run.testFiles);
  for (const measurement of result.measurements) {
    if (!run.testFiles.includes(measurement.file) || measurement.refreshRate !== run.refreshRate) {
      throw new Error("Unexpected original benchmark measurement.");
    }
    remaining.delete(measurement.file);
  }
  if (remaining.size > 0) throw new Error("Missing original benchmark timing population.");
  return result;
}

async function saveReport(directory, report) {
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  if (["shared", "cadence"].includes(process.env["INKBOOK_PERFORMANCE_SUITE"])) {
    const baseline = createBaselineReport(report, {
      suite: process.env["INKBOOK_PERFORMANCE_SUITE"],
      runId: process.env["GITHUB_RUN_ID"],
      runAttempt: process.env["GITHUB_RUN_ATTEMPT"],
    });
    await writeFile(join(directory, "baseline-report.json"), JSON.stringify(baseline) + "\n");
  }
  await writeFile(join(directory, "performance.json"), JSON.stringify(report, null, 2) + "\n");
}
