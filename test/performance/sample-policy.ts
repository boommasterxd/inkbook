import { performanceMode } from "./timing-budget";

export function statisticalSamples(referenceSamples: number): number {
  if (!Number.isSafeInteger(referenceSamples) || referenceSamples <= 0) {
    throw new TypeError("Statistical sample counts must be positive safe integers.");
  }
  return performanceMode() === "contracts" ? 1 : referenceSamples;
}

/** Keep action populations intact while avoiding nested run repetition in paired measurements. */
export function measurementRuns(referenceRuns: number): number {
  if (!Number.isSafeInteger(referenceRuns) || referenceRuns <= 0) {
    throw new TypeError("Measured run counts must be positive safe integers.");
  }
  return performanceMode() === "measurement" ? 1 : referenceRuns;
}
