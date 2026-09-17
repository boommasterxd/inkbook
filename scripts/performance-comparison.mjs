export const COMPARISON_STAGES = Object.freeze([6, 18]);
export const REGRESSION_RATIO = 1.2;
export const MAXIMUM_COMPARISON_METRICS = 20_000;

/** Fixed two-look sign test of paired ratios against the shared regression threshold. */
export function compareTimingRounds(referenceRounds, candidateRounds) {
  if (referenceRounds?.length !== candidateRounds?.length) {
    throw new Error("Performance comparison requires matching paired round counts.");
  }
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
  if (!Array.isArray(rounds) || !COMPARISON_STAGES.includes(rounds.length)) {
    throw new Error("Performance comparison requires exactly six or eighteen paired rounds.");
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

export function validTimingContract(record) {
  if ("statistic" in record) return false;
  if (record.comparison === "relative") {
    return (
      [record.referenceMs, record.limitMs, record.ratio].every((value) => value === null) &&
      typeof record.label === "string" &&
      record.label.trim().length > 0
    );
  }
  return (
    ["lt", "lte"].includes(record.comparison) &&
    Number.isFinite(record.referenceMs) &&
    record.referenceMs > 0 &&
    (record.limitMs === undefined || (Number.isFinite(record.limitMs) && record.limitMs > 0)) &&
    (record.ratio === undefined ||
      (Number.isFinite(record.ratio) && record.ratio === record.actualMs / record.referenceMs))
  );
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
    !validTimingContract(record)
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
      current.comparison !== initial.comparison ||
      (initial.comparison === "relative" && current.label !== initial.label)
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
  const first = classifyStage(ratios.slice(0, COMPARISON_STAGES[0]));
  const decision =
    first.status !== "inconclusive" || ratios.length === COMPARISON_STAGES[0]
      ? first
      : classifyStage(ratios);
  return {
    key,
    regressionRatio: REGRESSION_RATIO,
    ratios,
    minRatio: ratios.includes(null) ? null : Math.min(...ratios),
    maxRatio: ratios.includes(null) ? null : Math.max(...ratios),
    ...decision,
  };
}

function classifyStage(ratios) {
  const stage = ratios.length;
  const requiredSigns = stage === COMPARISON_STAGES[0] ? 6 : 14;
  const belowCount = ratios.filter((value) => value !== null && value < REGRESSION_RATIO).length;
  const aboveCount = ratios.filter((value) => value !== null && value > REGRESSION_RATIO).length;
  const ordered = ratios.includes(null) ? null : [...ratios].sort((left, right) => left - right);
  const status = !ordered
    ? "inconclusive"
    : belowCount >= requiredSigns
      ? "pass"
      : aboveCount >= requiredSigns
        ? "regression"
        : "inconclusive";
  return {
    stage,
    requiredSigns,
    belowCount,
    aboveCount,
    lowerMedianBound: ordered?.[stage - requiredSigns] ?? null,
    upperMedianBound: ordered?.[requiredSigns - 1] ?? null,
    status,
  };
}
