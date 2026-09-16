import {
  PERFORMANCE_TEST_MANIFEST,
  TIMING_PERFORMANCE_FILES,
} from "./performance-test-manifest.mjs";

const SHA = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;

/** Promotion never requests more samples or spends the regression gate's 50% margin. */
export function isStrictImprovement(ratios) {
  return isNonRegression(ratios) && ratios.slice(0, 6).every((ratio) => ratio < 1);
}

export function isNonRegression(ratios) {
  return (
    Array.isArray(ratios) &&
    [6, 18].includes(ratios.length) &&
    ratios.slice(0, 6).every((ratio) => Number.isFinite(ratio) && ratio > 0 && ratio <= 1)
  );
}

export function baselineContractPopulation(suite) {
  const groups =
    suite === "shared"
      ? [
          ["invariant", [120]],
          ["budgetOnly", [240]],
        ]
      : suite === "cadence"
        ? [["cadenceSensitive", [60, 90, 120, 144, 240]]]
        : [];
  return groups.flatMap(([category, rates]) =>
    rates.flatMap((refreshRate) =>
      PERFORMANCE_TEST_MANIFEST[category].map((file) => ({ file, refreshRate })),
    ),
  );
}

const populationKey = ({ file, refreshRate }) => JSON.stringify([file, refreshRate]);

function completeContracts(report, expected) {
  const remaining = new Set(expected.map(populationKey));
  for (const batch of report.batches ?? []) {
    if (batch.mode !== "contracts") continue;
    if (batch.variant !== "candidate" || batch.violations?.length !== 0) return false;
    for (const file of batch.files ?? []) {
      if (!remaining.delete(populationKey({ file, refreshRate: batch.refreshRate }))) return false;
    }
  }
  return expected.length > 0 && remaining.size === 0;
}

function timingPopulation(comparison) {
  const measured = new Set();
  const keys = new Set();
  for (const metric of comparison.metrics ?? []) {
    const [file, testName, ordinal, refreshRate] = JSON.parse(metric.key);
    if (!testName || !Number.isSafeInteger(ordinal) || ordinal <= 0 || keys.has(metric.key))
      return null;
    keys.add(metric.key);
    measured.add(populationKey({ file, refreshRate }));
  }
  for (const proof of comparison.identicalInputs ?? []) {
    const key = populationKey(proof);
    if (!HASH.test(proof.inputHash) || measured.has(key)) return null;
    measured.add(key);
  }
  return measured;
}

function completeTiming(comparison, expected, metadata, timingMetricKeys) {
  if (comparison.status === "identical-source") {
    return (
      HASH.test(comparison.sourceHash) &&
      comparison.sourceHash === metadata.candidateSourceHash &&
      comparison.sourceHash === metadata.anchorSourceHash
    );
  }
  if (!["pass", "identical-inputs"].includes(comparison.status)) return false;
  const expectedTiming = new Set(
    expected.filter(({ file }) => TIMING_PERFORMANCE_FILES.includes(file)).map(populationKey),
  );
  const actual = timingPopulation(comparison);
  return (
    actual !== null &&
    actual.size === expectedTiming.size &&
    [...actual].every((key) => expectedTiming.has(key)) &&
    completeMetrics(comparison, timingMetricKeys)
  );
}

function completeMetrics(comparison, timingMetricKeys) {
  const remaining = expectedMeasuredMetricKeys(timingMetricKeys, comparison.identicalInputs ?? []);
  for (const metric of comparison.metrics ?? []) {
    if (!remaining.delete(metric.key)) return false;
  }
  return remaining.size === 0;
}

export function expectedMeasuredMetricKeys(timingMetricKeys, identicalInputs) {
  const identical = new Set(identicalInputs.map(populationKey));
  return new Set(
    timingMetricKeys.filter((key) => {
      const [file, , , refreshRate] = JSON.parse(key);
      return !identical.has(populationKey({ file, refreshRate }));
    }),
  );
}

function contractMetricKeys(report) {
  return (report.batches ?? [])
    .filter(({ mode }) => mode === "contracts")
    .flatMap((batch) =>
      (batch.measurements ?? []).map(({ file, testName, ordinal, refreshRate }) =>
        JSON.stringify([file, testName, ordinal, refreshRate]),
      ),
    );
}

function validIdentity(metadata, context) {
  return (
    [metadata.harnessCommit, metadata.testedTree, metadata.anchorCommit, metadata.baseCommit].every(
      (value) => SHA.test(value),
    ) &&
    [metadata.candidateSourceHash, metadata.harnessHash, metadata.lockSha256].every((value) =>
      HASH.test(value),
    ) &&
    /^[1-9][0-9]*$/u.test(context.runId) &&
    /^[1-9][0-9]*$/u.test(context.runAttempt) &&
    metadata.dirty === false
  );
}

/** A compact handoff only; privileged promotion independently validates its contents. */
export function createBaselineReport(report, context) {
  const metadata = report.metadata ?? {};
  const expected = baselineContractPopulation(context.suite);
  const timingMetricKeys = contractMetricKeys(report);
  const anchor = report.comparisons?.find(({ variant }) => variant === "anchor");
  const metrics = (anchor?.metrics ?? []).map(({ key, ratios }) => ({
    key,
    ratios: Array.isArray(ratios) ? ratios.slice(0, 6) : [],
    status: isStrictImprovement(ratios)
      ? "improved"
      : isNonRegression(ratios)
        ? "non-regressing"
        : "inconclusive",
  }));
  const complete = completeEvidence(report, context, { expected, timingMetricKeys, anchor });
  return {
    version: 1,
    suite: context.suite,
    runId: context.runId,
    runAttempt: context.runAttempt,
    testedCommit: metadata.harnessCommit,
    testedTree: metadata.testedTree,
    anchorCommit: metadata.anchorCommit,
    baseCommit: metadata.baseCommit,
    sourceHash: metadata.candidateSourceHash,
    anchorSourceHash: metadata.anchorSourceHash,
    harnessHash: metadata.harnessHash,
    lockSha256: metadata.lockSha256,
    dirty: metadata.dirty,
    eligible: complete && metrics.every(({ status }) => status !== "inconclusive"),
    improvedMetrics: metrics.filter(({ status }) => status === "improved").length,
    metrics,
    timingMetricKeys,
    contractPopulation: complete ? expected : [],
    identicalSource: anchor?.status === "identical-source",
    identicalInputs: (anchor?.identicalInputs ?? []).map(({ file, refreshRate, inputHash }) => ({
      file,
      refreshRate,
      inputHash,
    })),
  };
}

function completeEvidence(report, context, evidence) {
  const metadata = report.metadata ?? {};
  const { expected, timingMetricKeys, anchor } = evidence;
  try {
    return (
      validIdentity(metadata, context) &&
      !report.error &&
      report.violations?.length === 0 &&
      report.comparisons?.length === 2 &&
      ["base", "anchor"].every((variant) =>
        report.comparisons.some((comparison) => comparison.variant === variant),
      ) &&
      report.comparisons.every(({ status }) =>
        ["pass", "identical-source", "identical-inputs"].includes(status),
      ) &&
      completeContracts(report, expected) &&
      new Set(timingMetricKeys).size === timingMetricKeys.length &&
      completeTiming(anchor, expected, metadata, timingMetricKeys)
    );
  } catch {
    return false;
  }
}
