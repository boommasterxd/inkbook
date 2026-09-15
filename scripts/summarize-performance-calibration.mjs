import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTimingRecords } from "./performance-results.mjs";
import { PERFORMANCE_TEST_MANIFEST } from "./performance-test-manifest.mjs";
import { selectPerformanceRuns } from "./performance-test-runner.mjs";

const SUITES = ["shared", "cadence"];
const IDENTITY_FIELDS = ["commit", "sourceTree", "lockSha256", "node", "runId", "runAttempt"];

function expectedFiles(suite) {
  return new Set(
    selectPerformanceRuns(PERFORMANCE_TEST_MANIFEST, suite).flatMap((run) =>
      run.testFiles.map((file) => JSON.stringify([file, run.refreshRate])),
    ),
  );
}

function validateMetadata(metadata, baseline) {
  if (
    !metadata ||
    metadata.dirty !== false ||
    metadata.profile !== "hosted-ubuntu" ||
    metadata.platform !== "linux" ||
    !/^ubuntu/.test(metadata.image ?? "") ||
    !/^[1-9][0-9]*$/.test(metadata.runId ?? "") ||
    !/^[1-9][0-9]*$/.test(metadata.runAttempt ?? "") ||
    !/^[a-f0-9]{40}$/.test(metadata.commit) ||
    !/^[a-f0-9]{40}$/.test(metadata.sourceTree) ||
    !/^[a-f0-9]{64}$/.test(metadata.lockSha256) ||
    !/^v26\.\d+\.\d+$/.test(metadata.node)
  ) {
    throw new Error(
      "Calibration requires valid metadata from a clean hosted Ubuntu Node.js 26 run.",
    );
  }
  for (const field of IDENTITY_FIELDS) {
    if (metadata[field] !== baseline[field]) {
      throw new Error(`Calibration metadata differs: ${field}.`);
    }
  }
}

function artifactMetrics(artifact) {
  const remaining = expectedFiles(artifact.suite);
  const metrics = new Map();
  if (!Array.isArray(artifact.results)) throw new Error("Invalid calibration results.");
  for (const result of artifact.results) {
    const fileKey = JSON.stringify([result.file, result.refreshRate]);
    if (!remaining.delete(fileKey)) throw new Error(`Unexpected or duplicate file: ${fileKey}.`);
    if (!Array.isArray(result.violations) || result.violations.length > 0) {
      throw new Error(`Incomplete clean calibration: violations in ${result.file}.`);
    }
    const measurements = parseTimingRecords(
      `INKBOOK_TIMING_RECORDS ${JSON.stringify(result.measurements)}\n`,
    );
    for (const measurement of measurements) {
      if (measurement.refreshRate !== result.refreshRate) {
        throw new Error(`Measurement refresh rate differs in ${result.file}.`);
      }
      const key = JSON.stringify([
        result.file,
        result.refreshRate,
        measurement.testName,
        measurement.ordinal,
      ]);
      if (metrics.has(key)) throw new Error(`Duplicate measurement: ${key}.`);
      metrics.set(key, { file: result.file, ...measurement });
    }
  }
  if (remaining.size > 0)
    throw new Error(`Missing calibration files: ${[...remaining].join(", ")}.`);
  if (metrics.size === 0) throw new Error("Calibration measurement population is empty.");
  return metrics;
}

function combineMetrics(samples) {
  const first = samples[0];
  if (samples.some((sample) => sample.size !== first.size)) {
    throw new Error("Calibration measurement populations differ.");
  }
  return [...first].map(([key, initial]) => {
    const values = samples.map((sample) => {
      const measurement = sample.get(key);
      if (
        !measurement ||
        measurement.referenceMs !== initial.referenceMs ||
        measurement.limitMs !== initial.limitMs ||
        measurement.comparison !== initial.comparison
      ) {
        throw new Error(`Calibration measurement contract differs: ${key}.`);
      }
      return measurement.actualMs;
    });
    return {
      file: initial.file,
      refreshRate: initial.refreshRate,
      testName: initial.testName,
      ordinal: initial.ordinal,
      referenceMs: initial.referenceMs,
      comparison: initial.comparison,
      limitMs: initial.limitMs,
      ...(initial.label === undefined ? {} : { label: initial.label }),
      actualMs: values,
      maxRatio: Math.max(...values) / initial.referenceMs,
    };
  });
}

export function summarizePerformanceCalibration(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length !== 6) {
    throw new Error("Calibration requires exactly six artifacts.");
  }
  const baseline = artifacts[0].metadata;
  const indexed = new Map();
  for (const artifact of artifacts) {
    if (!SUITES.includes(artifact.suite) || ![1, 2, 3].includes(artifact.sample)) {
      throw new Error("Invalid calibration artifact identity.");
    }
    const key = `${artifact.sample}-${artifact.suite}`;
    if (indexed.has(key)) throw new Error(`Duplicate calibration artifact: ${key}.`);
    validateMetadata(artifact.metadata, baseline);
    indexed.set(key, artifactMetrics(artifact));
  }
  const metrics = SUITES.flatMap((suite) =>
    combineMetrics([1, 2, 3].map((sample) => indexed.get(`${sample}-${suite}`))).map((metric) => ({
      suite,
      ...metric,
    })),
  );
  const maxRatio = metrics.reduce((maximum, metric) => Math.max(maximum, metric.maxRatio), 0);
  const candidate = Math.max(1, Math.ceil(maxRatio * 1.25 * 4) / 4);
  return {
    metadata: artifacts.map(({ sample, suite, metadata }) => ({ sample, suite, ...metadata })),
    metrics,
    maxRatio,
    candidate,
    adoptionBlocked: candidate > 5,
    candidates: Object.fromEntries(
      SUITES.map((suite) => {
        const maximum = metrics
          .filter((metric) => metric.suite === suite)
          .reduce((value, metric) => Math.max(value, metric.maxRatio), 0);
        return [suite, Math.max(1, Math.ceil(maximum * 1.25 * 4) / 4)];
      }),
    ),
  };
}

async function main() {
  const root = process.argv[2];
  if (!root || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/summarize-performance-calibration.mjs <artifact-root>");
  }
  const artifacts = [];
  for (const sample of [1, 2, 3]) {
    for (const suite of SUITES) {
      const directory = join(root, `calibration-${sample}-${suite}`);
      const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
      const results = JSON.parse(await readFile(join(directory, "measurements.json"), "utf8"));
      artifacts.push({ sample, suite, metadata, results });
    }
  }
  const summary = summarizePerformanceCalibration(artifacts);
  await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(
    `Commit: ${summary.metadata[0].commit}\nCandidate: ${summary.candidate}\nPer suite: ${JSON.stringify(summary.candidates)}\n`,
  );
  if (summary.adoptionBlocked) {
    process.stderr.write(
      `Calibration requires ${summary.candidate}, exceeding the existing 5. Adoption blocked.\n`,
    );
    process.exitCode = 1;
  }
  for (const metric of [...summary.metrics].sort((a, b) => b.maxRatio - a.maxRatio).slice(0, 10)) {
    process.stdout.write(
      `${metric.maxRatio.toFixed(4)}x ${metric.file} ${metric.refreshRate} Hz ` +
        `${metric.testName} #${metric.ordinal}\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
