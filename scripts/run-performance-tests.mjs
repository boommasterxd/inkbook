import {
  assertFullPerformanceEnvironment,
  collectPerformanceTestPlan,
  reportPerformanceViolations,
  runPerformanceRuns,
  selectPerformanceRuns,
} from "./performance-test-runner.mjs";

assertFullPerformanceEnvironment();
const runs = selectPerformanceRuns(await collectPerformanceTestPlan(), "all");
const violations = await runPerformanceRuns(runs);
reportPerformanceViolations(violations);
if (violations.length > 0) process.exitCode = 1;
