import { join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  collectPerformanceTestPlan,
  collectTestFiles,
  createPerformanceTestPlan,
  performanceRoot,
  selectPerformanceRuns,
  SUPPORTED_REFRESH_RATES,
} from "../../../scripts/performance-test-runner.mjs";

it("discovers every Vitest-supported performance extension and rejects unclassified files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inkbook-performance-discovery-"));
  try {
    await Promise.all(
      ["ts", "tsx", "mjs"].map((extension) =>
        writeFile(join(directory, `case.test.${extension}`), ""),
      ),
    );
    const discovered = await collectTestFiles(directory);
    expect(discovered.map((file) => file.slice(directory.length + 1))).toEqual([
      "case.test.mjs",
      "case.test.ts",
      "case.test.tsx",
    ]);
    const existing = await collectTestFiles();
    expect(() => createPerformanceTestPlan([...existing, ...discovered])).toThrow(
      "Unclassified performance tests",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("performance test plan", () => {
  it("classifies every benchmark exactly once", async () => {
    const discovered = await collectTestFiles();
    const plan = await collectPerformanceTestPlan();
    const classified = [...plan.invariant, ...plan.cadenceSensitive];

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
      ...SUPPORTED_REFRESH_RATES.map((refreshRate) => ["cadence-sensitive", refreshRate]),
    ]);
  });

  it("keeps every cadence profile in one cost-efficient CI shard", async () => {
    const plan = await collectPerformanceTestPlan();
    const runs = selectPerformanceRuns(plan, "cadence");

    expect(
      runs
        .filter(({ label }) => label === "cadence-sensitive")
        .map(({ refreshRate }) => refreshRate),
    ).toEqual(SUPPORTED_REFRESH_RATES);
    expect(
      runs
        .filter(({ label }) => label === "cadence-sensitive")
        .every(({ testFiles }) => testFiles === plan.cadenceSensitive),
    ).toBe(true);
  });

  it("partitions hosted coverage without dropping or duplicating local file/profile contracts", async () => {
    const plan = await collectPerformanceTestPlan();
    const keys = (runs) =>
      runs
        .flatMap(({ label, refreshRate, testFiles }) =>
          testFiles.map((file) => JSON.stringify([label, refreshRate, file])),
        )
        .toSorted();
    const hosted = [
      ...selectPerformanceRuns(plan, "shared"),
      ...selectPerformanceRuns(plan, "cadence"),
    ];
    expect(keys(hosted)).toEqual(keys(selectPerformanceRuns(plan, "all")));
    expect(new Set(keys(hosted)).size).toBe(
      plan.invariant.length + plan.cadenceSensitive.length * SUPPORTED_REFRESH_RATES.length,
    );
    expect(selectPerformanceRuns(plan, "shared")[0].testFiles).toEqual(plan.invariant);
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
