declare module "*scripts/performance-statistics.mjs" {
  /** Validate original statistic descriptors before selecting comparison scenarios. */
  export function validateComparisonStatistics(statistics: unknown): void;
  /** Extract statistics from retained intervals and complete-operation totals. */
  export function extractComparisonStatistics(
    result: unknown,
    side: "reference" | "candidate",
  ): { key: string; actualMs: number }[];
}
