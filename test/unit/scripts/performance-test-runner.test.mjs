import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectPerformanceTestPlan,
  collectTestFiles,
  createPerformanceTestPlan,
  performanceRoot,
  selectPerformanceRuns,
  SUPPORTED_REFRESH_RATES,
} from "../../../scripts/performance-test-runner.mjs";

describe("performance test plan", () => {
  it("classifies every benchmark exactly once", async () => {
    const discovered = await collectTestFiles();
    const plan = await collectPerformanceTestPlan();
    const classified = [...plan.invariant, ...plan.budgetOnly, ...plan.cadenceSensitive];

    expect(plan.invariant).toHaveLength(16);
    expect(plan.budgetOnly).toHaveLength(27);
    expect(plan.cadenceSensitive).toHaveLength(11);
    expect(new Set(classified).size).toBe(discovered.length);
    expect(classified.toSorted()).toEqual(discovered);
  });

  it("rejects a newly added benchmark until its data dependency is classified", async () => {
    const discovered = await collectTestFiles();
    const unclassified = join(performanceRoot, "unclassified-performance.test.ts");

    expect(() => createPerformanceTestPlan([...discovered, unclassified])).toThrow(
      "Unclassified performance tests",
    );
  });

  it("runs shared work once and cadence-sensitive work at every supported rate", async () => {
    const plan = await collectPerformanceTestPlan();
    const runs = selectPerformanceRuns(plan, "all");

    expect(runs.map(({ label, refreshRate }) => [label, refreshRate])).toEqual([
      ["refresh-rate-invariant", 120],
      ["budget-only", 240],
      ...SUPPORTED_REFRESH_RATES.map((refreshRate) => ["cadence-sensitive", refreshRate]),
    ]);
  });

  it("keeps every cadence profile in one cost-efficient CI shard", async () => {
    const plan = await collectPerformanceTestPlan();
    const runs = selectPerformanceRuns(plan, "cadence");

    expect(runs.map(({ refreshRate }) => refreshRate)).toEqual(SUPPORTED_REFRESH_RATES);
    expect(runs.every(({ testFiles }) => testFiles === plan.cadenceSensitive)).toBe(true);
  });

  it("requires an explicit supported rate for one CI profile shard", async () => {
    const plan = await collectPerformanceTestPlan();

    expect(selectPerformanceRuns(plan, "profile", "144")[0]).toMatchObject({
      label: "cadence-sensitive",
      refreshRate: 144,
    });
    expect(() => selectPerformanceRuns(plan, "profile", "75")).toThrow(
      "Unsupported performance refresh rate",
    );
    expect(() => selectPerformanceRuns(plan, "profile")).toThrow(
      "Unsupported performance refresh rate",
    );
  });
});
