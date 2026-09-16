import {
  baselineContractPopulation,
  expectedMeasuredMetricKeys,
} from "./performance-baseline-report.mjs";
import { TIMING_PERFORMANCE_FILES } from "./performance-test-manifest.mjs";

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_METRICS = 10_000;

export function requireBaseline(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateBaselineReports(reports, context) {
  requireBaseline(reports.length === 2, "Both performance shards are required");
  const suites = new Set();
  let improved = 0;
  for (const report of reports) {
    requireBaseline(report && report.version === 1, "Unsupported baseline report");
    requireBaseline(["shared", "cadence"].includes(report.suite), "Unknown performance suite");
    requireBaseline(!suites.has(report.suite), "Duplicate performance suite");
    suites.add(report.suite);
    validateIdentity(report, context);
    validatePopulation(report);
    requireBaseline(
      report.eligible === true && report.dirty === false,
      "Ineligible or dirty candidate",
    );
    requireBaseline(
      Array.isArray(report.metrics) && report.metrics.length <= MAX_METRICS,
      "Invalid metrics",
    );
    const keys = new Set();
    for (const metric of report.metrics) {
      requireBaseline(
        typeof metric.key === "string" && metric.key.length <= 1000 && !keys.has(metric.key),
        "Invalid metric key",
      );
      keys.add(metric.key);
      requireBaseline(
        ["improved", "non-regressing"].includes(metric.status),
        "A metric may regress",
      );
      requireBaseline(
        Array.isArray(metric.ratios) && metric.ratios.length === 6,
        "Six first-stage pairs are required",
      );
      requireBaseline(
        metric.ratios.every((ratio) => Number.isFinite(ratio) && ratio > 0 && ratio <= 1),
        "No changed metric pair may regress",
      );
      requireBaseline(
        metric.status ===
          (metric.ratios.every((ratio) => ratio < 1) ? "improved" : "non-regressing"),
        "Metric status mismatch",
      );
    }
    const count = report.metrics.filter(({ status }) => status === "improved").length;
    requireBaseline(report.improvedMetrics === count, "Improvement count mismatch");
    improved += count;
  }
  requireBaseline(improved > 0, "At least one measured improvement is required");
  requireBaseline(reports[0].sourceHash === reports[1].sourceHash, "Shard source mismatch");
  requireBaseline(reports[0].harnessHash === reports[1].harnessHash, "Shard harness mismatch");
  requireBaseline(reports[0].lockSha256 === reports[1].lockSha256, "Shard lockfile mismatch");
  return { improvedMetrics: improved, sourceHash: reports[0].sourceHash };
}

function validateIdentity(report, context) {
  for (const field of ["testedCommit", "testedTree", "anchorCommit", "baseCommit"]) {
    requireBaseline(SHA.test(report[field]), `Invalid ${field}`);
    requireBaseline(report[field] === context[field], `${field} mismatch`);
  }
  for (const field of ["runId", "runAttempt"]) {
    requireBaseline(
      /^\d+$/.test(report[field]) && report[field] === String(context[field]),
      `${field} mismatch`,
    );
  }
  for (const field of ["sourceHash", "harnessHash", "lockSha256"]) {
    requireBaseline(HASH.test(report[field]), `Invalid ${field}`);
  }
}

export function validateWorkflowRun(run, expected) {
  requireBaseline(
    run.event === "pull_request" && run.status === "completed" && run.conclusion === "success",
    "PR workflow did not succeed",
  );
  requireBaseline(
    run.path === `.github/workflows/${expected.workflow}`,
    "Unexpected workflow path",
  );
  requireBaseline(run.head_sha === expected.head, "Workflow head mismatch");
  requireBaseline(
    run.repository?.full_name === expected.repository,
    "Workflow repository mismatch",
  );
  // GitHub may clear this association after merge. Exact head/workflow identity plus
  // the separately verified synthetic-merge parents and merged tree bind that case.
  requireBaseline(
    Array.isArray(run.pull_requests) &&
      (run.pull_requests.length === 0 ||
        run.pull_requests.some((pr) => pr.number === expected.number)),
    "Workflow PR association mismatch",
  );
}

export function validateJobs(jobs, expectedNames) {
  for (const name of expectedNames) {
    const matches = jobs.filter((job) => job.name === name);
    requireBaseline(
      matches.length === 1 && matches[0].conclusion === "success",
      `Required check did not succeed: ${name}`,
    );
  }
}

const populationKey = ({ file, refreshRate }) => JSON.stringify([file, refreshRate]);

function validatePopulation(report) {
  const expected = baselineContractPopulation(report.suite);
  requireBaseline(Array.isArray(report.contractPopulation), "Missing contract population");
  requireBaseline(
    JSON.stringify(report.contractPopulation) === JSON.stringify(expected),
    "Incomplete contract population",
  );
  requireBaseline(
    Array.isArray(report.identicalInputs) && Array.isArray(report.metrics),
    "Missing timing population",
  );
  requireBaseline(HASH.test(report.anchorSourceHash), "Invalid anchor source hash");
  if (report.identicalSource === true) {
    requireBaseline(
      report.sourceHash === report.anchorSourceHash &&
        report.metrics.length === 0 &&
        report.identicalInputs.length === 0,
      "Invalid identical-source proof",
    );
    return;
  }
  requireBaseline(report.identicalSource === false, "Invalid identical-source flag");
  const remaining = new Set(
    expected.filter(({ file }) => TIMING_PERFORMANCE_FILES.includes(file)).map(populationKey),
  );
  const measured = new Set();
  for (const metric of report.metrics) {
    const fields = JSON.parse(metric.key);
    requireBaseline(Array.isArray(fields) && fields.length === 4, "Invalid metric identity");
    const [file, name, ordinal, refreshRate] = fields;
    requireBaseline(
      typeof name === "string" && name.length > 0 && Number.isSafeInteger(ordinal) && ordinal > 0,
      "Invalid metric identity",
    );
    measured.add(populationKey({ file, refreshRate }));
  }
  for (const key of measured)
    requireBaseline(remaining.delete(key), "Unexpected measured population");
  for (const proof of report.identicalInputs) {
    requireBaseline(
      HASH.test(proof.inputHash) && remaining.delete(populationKey(proof)),
      "Invalid or overlapping input proof",
    );
  }
  requireBaseline(remaining.size === 0, "Incomplete timing population");
  validateMetricPopulation(report);
}

function validateMetricPopulation(report) {
  requireBaseline(
    Array.isArray(report.timingMetricKeys) && report.timingMetricKeys.length <= MAX_METRICS,
    "Missing timing metric keys",
  );
  requireBaseline(
    new Set(report.timingMetricKeys).size === report.timingMetricKeys.length,
    "Duplicate contract metric key",
  );
  const remaining = expectedMeasuredMetricKeys(report.timingMetricKeys, report.identicalInputs);
  for (const metric of report.metrics)
    requireBaseline(remaining.delete(metric.key), "Unexpected timing metric");
  requireBaseline(remaining.size === 0, "Missing timing metric");
}
