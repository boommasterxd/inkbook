import type { ElementStoreInstrumentation } from "./types";

export type MutableStoreInstrumentation = {
  -readonly [Key in keyof ElementStoreInstrumentation]: ElementStoreInstrumentation[Key];
};

export const EMPTY_STORE_INSTRUMENTATION: ElementStoreInstrumentation = Object.freeze({
  anchorBuilds: 0,
  anchorCacheBytes: 0,
  anchorCacheEntries: 0,
  anchorCacheEvictions: 0,
  anchorCacheHits: 0,
  bandScans: 0,
  orderNodeVisits: 0,
  deltaEntries: 0,
  estimatedRetainedBytes: 0,
  fullStoreScans: 0,
  hydrationElementVisits: 0,
  hydrationYields: 0,
  identityChecks: 0,
  identityMatches: 0,
  publishedDeltas: 0,
  recordReplacements: 0,
  reverseDependencyVisits: 0,
  snapshotMaterializations: 0,
  timeSlicedIndexVisits: 0,
  timeSlicedReplacementYields: 0,
});
