export const COMPARISON_ROUNDS = 3;
export const REGRESSION_RATIO = 1.1;
export const MAXIMUM_ROUND_SPREAD = 1.2;
export const MAXIMUM_COMPARISON_METRICS = 20_000;

/** Compare observed paired ratios; three rounds do not establish a confidence interval. */
export function compareTimingRounds(referenceRounds, candidateRounds) {
  const references = indexRounds(referenceRounds);
  const candidates = indexRounds(candidateRounds);
  const baseline = references[0];
  for (const round of [...references, ...candidates]) validateContracts(baseline, round);
  const metrics = [...baseline.keys()].sort().map((key) =>
    compareMetric(
      key,
      references.map((round) => round.get(key).actualMs),
      candidates.map((round) => round.get(key).actualMs),
    ),
  );
  const status = metrics.some((metric) => metric.status === "regression")
    ? "regression"
    : metrics.some((metric) => metric.status === "inconclusive")
      ? "inconclusive"
      : "pass";
  return { status, metrics };
}

function indexRounds(rounds) {
  if (!Array.isArray(rounds) || rounds.length !== COMPARISON_ROUNDS) {
    throw new Error("Performance comparison requires exactly three paired rounds.");
  }
  return rounds.map((round) => {
    if (!Array.isArray(round) || round.length === 0 || round.length > MAXIMUM_COMPARISON_METRICS) {
      throw new Error("Invalid performance comparison population size.");
    }
    const indexed = new Map();
    for (const record of round) {
      validateRecord(record);
      const key = JSON.stringify([
        record.file,
        record.testName,
        record.ordinal,
        record.refreshRate,
      ]);
      if (indexed.has(key)) throw new Error(`Duplicate performance comparison metric: ${key}.`);
      indexed.set(key, record);
    }
    return indexed;
  });
}

function validateRecord(record) {
  if (
    !record ||
    typeof record.file !== "string" ||
    record.file.length === 0 ||
    typeof record.testName !== "string" ||
    record.testName.length === 0 ||
    !Number.isSafeInteger(record.ordinal) ||
    record.ordinal <= 0 ||
    ![60, 90, 120, 144, 240].includes(record.refreshRate) ||
    !Number.isFinite(record.actualMs) ||
    record.actualMs < 0 ||
    !Number.isFinite(record.referenceMs) ||
    record.referenceMs <= 0 ||
    !["lt", "lte"].includes(record.comparison)
  ) {
    throw new Error("Invalid performance comparison measurement.");
  }
}

function validateContracts(baseline, round) {
  if (round.size !== baseline.size) throw new Error("Performance metric populations differ.");
  for (const [key, initial] of baseline) {
    const current = round.get(key);
    if (
      !current ||
      current.referenceMs !== initial.referenceMs ||
      current.comparison !== initial.comparison
    ) {
      throw new Error(`Performance metric identity or contract differs: ${key}.`);
    }
  }
}

function compareMetric(key, referenceValues, candidateValues) {
  const ratios = candidateValues.map((value, index) => {
    const reference = referenceValues[index];
    if (value === 0 || reference === 0) return null;
    const ratio = value / reference;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      throw new Error(`Unrepresentable performance comparison ratio: ${key}.`);
    }
    return ratio;
  });
  if (ratios.includes(null)) {
    return { key, ratios, minRatio: null, maxRatio: null, status: "inconclusive" };
  }
  const minRatio = Math.min(...ratios);
  const maxRatio = Math.max(...ratios);
  const noisy = maxRatio / minRatio > MAXIMUM_ROUND_SPREAD;
  const status =
    minRatio > REGRESSION_RATIO
      ? "regression"
      : !noisy && maxRatio <= REGRESSION_RATIO
        ? "pass"
        : "inconclusive";
  return { key, ratios, minRatio, maxRatio, status };
}
