import { runPerformanceBatch } from "./performance-batch.mjs";

export async function executePerformanceGate(projectRoot, runs) {
  if (!Array.isArray(runs) || runs.length === 0)
    throw new Error("Empty performance execution plan.");
  const violations = [];
  for (const run of runs) {
    process.stdout.write(`\nDeterministic contracts: ${run.label}, ${run.refreshRate} Hz\n`);
    const result = await runPerformanceBatch({
      root: projectRoot,
      testFiles: run.testFiles,
      refreshRate: run.refreshRate,
    });
    violations.push(...result.violations);
    process.stdout.write(`  ${result.files.length} files checked\n`);
  }
  return violations;
}
