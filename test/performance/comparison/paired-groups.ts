import type { ComparisonScenario } from "./contracts";

/** Validate all groups before creating any fixture; preserve first-occurrence execution order. */
export function groupComparisonScenarios(
  scenarios: readonly ComparisonScenario[],
): readonly (readonly ComparisonScenario[])[] {
  validateComparisonIds(scenarios);
  const groups = new Map<string, ComparisonScenario[]>();
  const result: ComparisonScenario[][] = [];
  for (const scenario of scenarios) {
    if (scenario.measurementGroup === undefined) {
      result.push([scenario]);
      continue;
    }
    if (
      !scenario.measurementGroup.trim() ||
      (scenario.execution !== "sequence" && scenario.execution !== "async-sequence")
    )
      throw new Error(`Invalid comparison measurement group: ${scenario.id}`);
    const group = groups.get(scenario.measurementGroup);
    if (group) {
      if (workloadSignature(group[0]!) !== workloadSignature(scenario))
        throw new Error(`Mismatched comparison measurement group: ${scenario.measurementGroup}`);
      group.push(scenario);
    } else {
      const created = [scenario];
      groups.set(scenario.measurementGroup, created);
      result.push(created);
    }
  }
  return result;
}

function workloadSignature(scenario: ComparisonScenario): string {
  return JSON.stringify([
    scenario.modules,
    scenario.execution,
    scenario.sequenceLength,
    scenario.warmupOperations,
  ]);
}

export function validateComparisonIds(scenarios: readonly ComparisonScenario[]): void {
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (!scenario.id || ids.has(scenario.id))
      throw new Error(`Duplicate or empty comparison scenario ID: ${scenario.id}`);
    ids.add(scenario.id);
  }
}
