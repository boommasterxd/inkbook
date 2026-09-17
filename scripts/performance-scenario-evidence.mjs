import { validTimingContract } from "./performance-comparison.mjs";

export const scenarioKey = ({ file, testName }) => JSON.stringify([file, testName]);

export function selectTimingScenarios(population) {
  return [
    ...new Map(
      population.map(({ file, testName }) => [scenarioKey({ file, testName }), { file, testName }]),
    ).values(),
  ];
}

function metricKey(record) {
  return JSON.stringify([record.file, record.testName, record.ordinal, record.refreshRate]);
}

/** Contract observations declare the population; their elapsed values are not a baseline. */
export function validateScenarioMeasurements(expected, measurements) {
  if (measurements.length !== expected.length || expected.length === 0) {
    throw new Error("Missing or extra original benchmark timing population.");
  }
  const remaining = new Map(expected.map((record) => [metricKey(record), record]));
  if (remaining.size !== expected.length) throw new Error("Duplicate contract timing population.");
  for (const record of measurements) {
    const key = metricKey(record);
    const contract = remaining.get(key);
    if (
      !contract ||
      !validTimingContract(record) ||
      !Number.isFinite(record.actualMs) ||
      record.actualMs < 0 ||
      record.referenceMs !== contract.referenceMs ||
      record.comparison !== contract.comparison ||
      record.limitMs !== contract.limitMs ||
      record.label !== contract.label
    ) {
      throw new Error(`Performance metric identity or contract differs: ${key}.`);
    }
    remaining.delete(key);
  }
}
