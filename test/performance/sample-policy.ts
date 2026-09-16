import { performanceMode } from "./timing-budget";

export function statisticalSamples(referenceSamples: number): number {
  if (!Number.isSafeInteger(referenceSamples) || referenceSamples <= 0) {
    throw new TypeError("Statistical sample counts must be positive safe integers.");
  }
  return performanceMode() === "contracts" ? 1 : referenceSamples;
}
