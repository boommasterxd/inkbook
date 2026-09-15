// @vitest-environment happy-dom
import { validateComparisonStatistics } from "../../../../scripts/performance-statistics.mjs";
import { describe, expect, it } from "vitest";
import type { ComparisonScenario } from "../../../performance/comparison/contracts";
import {
  COMPARISON_SCENARIOS,
  selectComparisonScenarios,
  validateComparisonCoverage,
} from "../../../performance/comparison/scenarios";

const record = {
  file: "measured.test.ts",
  testName: "suite > operation",
  ordinal: 1,
  refreshRate: 240,
};
function scenario(id: string, ordinal = 1): ComparisonScenario {
  return {
    id,
    modules: ["domain/model"],
    covers: [{ file: record.file, test: "operation", ordinals: [ordinal] }],
    statistics: [{ kind: "max", population: "operations" }],
    execution: "sync",

    warmupOperations: 1,
    create: () => ({ run: () => undefined, verify: () => undefined, dispose: () => undefined }),
  };
}

describe("comparison scenario coverage", () => {
  it("permits several kernels for the same original timing phase and selects all", () => {
    const scenarios = [scenario("first"), scenario("second")];
    expect(selectComparisonScenarios([record], scenarios)).toEqual(scenarios);
    expect(() =>
      validateComparisonCoverage(scenarios, [record, { ...record, refreshRate: 60 }]),
    ).not.toThrow();
  });

  it("rejects an uncovered original ordinal, file, or title", () => {
    for (const change of [{ ordinal: 2 }, { file: "other.test.ts" }, { testName: "other" }]) {
      expect(() =>
        validateComparisonCoverage([scenario("one")], [{ ...record, ...change }]),
      ).toThrow("Uncovered");
    }
  });

  it("rejects unmatched selected kernels instead of silently omitting them", () => {
    expect(() =>
      selectComparisonScenarios([record], [scenario("one"), scenario("two", 2)]),
    ).toThrow("matches no original");
  });

  it("filters unrelated files while requiring globally unique registry IDs", () => {
    const unrelated = { ...scenario("other"), covers: [{ file: "other.test.ts", test: "other" }] };
    expect(
      selectComparisonScenarios([record], [scenario("one"), unrelated]).map(({ id }) => id),
    ).toEqual(["one"]);
    expect(() =>
      selectComparisonScenarios([record], [scenario("one"), { ...unrelated, id: "one" }]),
    ).toThrow("Duplicate");
  });

  it("rejects invalid or empty populations and malformed coverage", () => {
    expect(() => validateComparisonCoverage([], [record])).toThrow("Empty");
    expect(() => validateComparisonCoverage([scenario("one")], [])).toThrow("Empty");
    expect(() =>
      validateComparisonCoverage([scenario("one")], [{ ...record, refreshRate: 0 }]),
    ).toThrow("Invalid");
    expect(() => validateComparisonCoverage([scenario("one", 0)], [record])).toThrow(
      "Invalid comparison coverage",
    );
  });

  it("registers chrome and all kernel families without duplicate identifiers", () => {
    for (const scenario of COMPARISON_SCENARIOS) {
      expect(() => validateComparisonStatistics(scenario.statistics), scenario.id).not.toThrow();
    }
    const ids = COMPARISON_SCENARIOS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const family of ["domain", "editor", "obsidian", "persistence", "rendering"]) {
      expect(ids.some((id) => id.startsWith(family))).toBe(true);
    }
    expect(ids).toContain("rendering-semantic-chrome");
  });
});
