import {
  collectPerformanceTestPlan,
  reportPerformanceViolations,
  runPerformanceRuns,
  selectPerformanceRuns,
} from "./performance-test-runner.mjs";

const suite = process.env["INKBOOK_PERFORMANCE_SUITE"] ?? "all";
const runs = selectPerformanceRuns(
  await collectPerformanceTestPlan(),
  suite,
  process.env["INKBOOK_PERFORMANCE_REFRESH_RATE"],
);
const violations = await runPerformanceRuns(runs);
reportPerformanceViolations(violations);
if (violations.length > 0) process.exitCode = 1;
