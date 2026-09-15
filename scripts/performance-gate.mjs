import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runPerformanceBatch } from "./performance-batch.mjs";
import { runKernelBatch } from "./performance-kernel-batch.mjs";
import { TIMING_PERFORMANCE_FILES } from "./performance-test-manifest.mjs";
import { COMPARISON_ROUNDS, compareTimingRounds } from "./performance-comparison.mjs";
import { preparePerformanceWorkspaces } from "./performance-workspace.mjs";
import { extractComparisonStatistics } from "./performance-statistics.mjs";

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
    anchor: policy.anchorCommit,
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
      await validateCoverage(workspaces, report);
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

async function validateCoverage(workspaces, report) {
  const measurements = report.batches.flatMap((batch) => batch.measurements);
  if (measurements.length === 0) return;
  report.coverage = await runKernelBatch({
    root: workspaces.candidate.root,
    referenceRoot: workspaces.candidate.root,
    candidateRoot: workspaces.candidate.root,
    testFiles: [...new Set(measurements.map((value) => value.file))],
    contractMeasurements: measurements,
    refreshRate: 120,
    reportDirectory: evidencePath(workspaces, "coverage"),
    coverageOnly: true,
  });
  const ids = report.coverage?.ids;
  if (
    report.coverage?.kind !== "kernel-coverage" ||
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((id) => typeof id !== "string" || !id) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error("Missing or invalid comparison coverage evidence.");
  }
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
  const referenceRounds = [];
  const candidateRounds = [];
  const identicalRounds = [];
  for (let round = 0; round < COMPARISON_ROUNDS; round += 1) {
    const reference = [];
    const candidate = [];
    const identical = [];
    for (const run of runs) {
      const contract = report.batches.find(
        (batch) =>
          batch.mode === "contracts" &&
          batch.run === run.label &&
          batch.refreshRate === run.refreshRate,
      );
      const measurements = contract?.measurements ?? [];
      if (measurements.length === 0) continue;
      process.stdout.write(`\nPaired work: ${variant}, round ${round + 1}, ${run.label}\n`);
      const result = await runKernelBatch({
        root: workspaces.candidate.root,
        referenceRoot: workspaces[variant].root,
        roundIndex: round,
        candidateRoot: workspaces.candidate.root,
        testFiles: [...new Set(measurements.map((value) => value.file))],
        contractMeasurements: measurements,
        reportDirectory: evidencePath(
          workspaces,
          variant,
          String(round),
          run.label,
          String(run.refreshRate),
        ),
        refreshRate: run.refreshRate,
      });
      appendPairedEvidence(report, result, { variant, round, run, workspaces });
      identical.push(...result.identicalInputs);
      for (const measurement of result.measurements) {
        reference.push(...comparisonRecords(measurement, "reference"));
        candidate.push(...comparisonRecords(measurement, "candidate"));
      }
    }
    validateRoundEvidence(reference, identical, report.coverage?.ids ?? []);
    referenceRounds.push(reference);
    candidateRounds.push(candidate);
    identicalRounds.push(
      identical.toSorted((left, right) =>
        JSON.stringify([left.id, left.refreshRate]).localeCompare(
          JSON.stringify([right.id, right.refreshRate]),
        ),
      ),
    );
  }
  if (identicalRounds.some((round) => JSON.stringify(round) !== JSON.stringify(identicalRounds[0])))
    throw new Error("Identical-input populations differ across rounds.");
  if (referenceRounds.every((round) => round.length === 0))
    return { status: "identical-inputs", metrics: [], identicalInputs: identicalRounds[0] };
  return {
    ...compareTimingRounds(referenceRounds, candidateRounds),
    identicalInputs: identicalRounds[0],
  };
}

function appendPairedEvidence(report, result, { variant, round, run, workspaces }) {
  report.batches.push({
    variant,
    mode: "paired",
    round,
    run: run.label,
    refreshRate: run.refreshRate,
    measurementCount: result?.measurements?.length ?? 0,
    identicalInputCount: result?.identicalInputs?.length ?? 0,
    artifact: join(
      evidencePath(workspaces, variant, String(round), run.label, String(run.refreshRate)),
      "kernel.json",
    ),
  });
  if (
    !Array.isArray(result?.measurements) ||
    !Array.isArray(result?.identicalInputs) ||
    result.measurements.length + result.identicalInputs.length === 0
  )
    throw new Error("Missing paired results.");
  if (
    [...result.measurements, ...result.identicalInputs].some(
      (value) => value?.refreshRate !== run.refreshRate,
    )
  )
    throw new Error("Wrong-profile paired results.");
}

function validateRoundEvidence(measurements, identical, expectedIds) {
  if (measurements.length + identical.length === 0) throw new Error("Empty comparison evidence.");
  for (const proof of identical) {
    if (
      !/^[a-f0-9]{64}$/.test(proof.inputHash ?? "") ||
      !Array.isArray(proof.inputs) ||
      proof.inputs.length === 0 ||
      proof.inputs.some((file) => typeof file !== "string" || !file)
    ) {
      throw new Error("Invalid identical-input evidence.");
    }
  }
  const remaining = new Set(expectedIds);
  const seen = new Set();
  const identities = new Map();
  for (const record of [...measurements, ...identical]) {
    const id = record.scenarioId ?? record.id;
    const key = JSON.stringify([record.testName ?? record.id, record.refreshRate]);
    const scenarioKey = JSON.stringify([id, record.refreshRate]);
    const measured = record.scenarioId !== undefined;
    if (
      !expectedIds.includes(id) ||
      seen.has(key) ||
      identities.get(scenarioKey) === false ||
      (!measured && identities.has(scenarioKey))
    )
      throw new Error("Unexpected or duplicate comparison evidence.");
    identities.set(scenarioKey, measured);
    seen.add(key);
    remaining.delete(id);
  }
  if (remaining.size > 0) throw new Error("Missing comparison scenario evidence.");
}

function comparisonRecords(result, side) {
  const metrics = [
    { key: "mean-work", actualMs: result[`${side}Ms`] },
    ...extractComparisonStatistics(result, side),
  ];
  return metrics.map(({ key, actualMs }) => ({
    file: "paired-kernel",
    testName: JSON.stringify([result.id, key]),
    scenarioId: result.id,
    ordinal: 1,
    refreshRate: result.refreshRate,
    actualMs,
    // Original statistics and mean work each enforce the same relative regression policy.
    referenceMs: 1,
    comparison: "lte",
  }));
}

async function saveReport(directory, report) {
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "performance.json"), JSON.stringify(report, null, 2) + "\n");
}
