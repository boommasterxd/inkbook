const KINDS = new Set(["p50", "p95", "p99", "max", "total", "mean"]);
const MAXIMUM_SAMPLES = 1_000_000;

export function validateComparisonStatistics(statistics) {
  if (!Array.isArray(statistics) || statistics.length === 0 || statistics.length > 12) {
    throw new Error("Missing or invalid comparison statistics.");
  }
  const keys = new Set();
  for (const statistic of statistics) {
    if (
      !statistic ||
      !KINDS.has(statistic.kind) ||
      !["samples", "operations"].includes(statistic.population) ||
      !validEstimator(statistic) ||
      !validOptionalCount(statistic.minimumSamples) ||
      !validOptionalCount(statistic.minimumOperations) ||
      !validWindow(statistic) ||
      (statistic.fallback !== undefined &&
        (statistic.fallback !== "max" ||
          statistic.minimumSamples === undefined ||
          !statistic.kind.startsWith("p"))) ||
      (statistic.kind === "total" && statistic.population !== "operations")
    )
      throw new Error("Invalid comparison statistic contract.");
    const key = `${statistic.population}:${statistic.kind}`;
    if (keys.has(key)) throw new Error(`Duplicate comparison statistic: ${key}`);
    keys.add(key);
  }
}

/** Evaluate retained phase intervals, never averages of timing batches. */
export function extractComparisonStatistics(result, side) {
  validateComparisonStatistics(result?.statistics);
  if (!["reference", "candidate"].includes(side)) throw new Error("Invalid comparison side.");
  return result.statistics.map((statistic) => {
    const values = population(result, side, statistic.population);
    if (
      statistic.minimumOperations !== undefined &&
      population(result, side, "operations").length < statistic.minimumOperations
    ) {
      throw new Error(`Insufficient complete operations for ${statistic.kind}`);
    }
    const tooSmall = values.length < (statistic.minimumSamples ?? 1);
    if (tooSmall && statistic.fallback === undefined) {
      throw new Error(
        `Insufficient ${statistic.population} for ${statistic.kind}: ${values.length}`,
      );
    }
    const kind = tooSmall ? statistic.fallback : statistic.kind;
    return {
      key: `${statistic.population}:${statistic.kind}`,
      actualMs: summarizeStatistic(values, kind, statistic),
    };
  });
}

function population(result, side, source) {
  if (!Array.isArray(result.blocks) || result.blocks.length === 0)
    throw new Error("Missing comparison blocks.");
  const values = [];
  for (const block of result.blocks) {
    if (!Array.isArray(block.measurements)) throw new Error("Missing block measurements.");
    const measurements = block.measurements.filter((item) => item.side === side);
    if (measurements.length === 0) throw new Error("Missing paired statistic population.");
    for (const measurement of measurements) {
      const samples = source === "samples" ? measurement.samplesMs : measurement.operationWorkMs;
      if (
        !Array.isArray(samples) ||
        samples.length === 0 ||
        values.length + samples.length > MAXIMUM_SAMPLES ||
        samples.some((value) => !Number.isFinite(value) || value < 0)
      )
        throw new Error("Invalid statistic population.");
      for (const value of samples) values.push(value);
    }
  }
  return values;
}

function summarize(values, kind, estimator) {
  if (kind === "mean") return values.reduce((sum, value) => sum + value / values.length, 0);
  // A total contract times one complete operation, not the sum of adaptive repetitions.
  if (kind === "max" || kind === "total")
    return values.reduce((largest, value) => Math.max(largest, value), 0);
  const sorted = [...values].sort((left, right) => left - right);
  const fraction = Number(kind.slice(1)) / 100;
  const index =
    estimator === "upper-rank"
      ? Math.floor(sorted.length * fraction)
      : Math.ceil(sorted.length * fraction) - 1;
  return sorted[Math.min(index, sorted.length - 1)];
}

function validOptionalCount(value) {
  return (
    value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= MAXIMUM_SAMPLES)
  );
}

function validWindow(statistic) {
  if (statistic.aggregation === undefined) return statistic.windowSize === undefined;
  return (
    statistic.aggregation === "worst-window" &&
    statistic.windowSize !== undefined &&
    validOptionalCount(statistic.windowSize) &&
    statistic.kind.startsWith("p")
  );
}

function summarizeStatistic(values, kind, statistic) {
  if (statistic.aggregation !== "worst-window") return summarize(values, kind, statistic.estimator);
  let worst = 0;
  for (let start = 0; start < values.length; start += statistic.windowSize) {
    const window = values.slice(start, start + statistic.windowSize);
    // Retain every final partial window conservatively; never discard measured work.
    const windowKind = window.length === statistic.windowSize ? kind : "max";
    worst = Math.max(worst, summarize(window, windowKind, statistic.estimator));
  }
  return worst;
}

function validEstimator(statistic) {
  return (
    statistic.estimator === undefined ||
    (["nearest-rank", "upper-rank"].includes(statistic.estimator) && statistic.kind.startsWith("p"))
  );
}
