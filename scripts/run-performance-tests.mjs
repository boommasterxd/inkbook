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
const violations = await runPerformanceRuns(runs, {
  failFast: process.env["CI"] === "true" && process.env["INKBOOK_PERFORMANCE_CALIBRATION"] !== "1",
});
reportPerformanceViolations(violations);
if (violations.length > 0) process.exitCode = 1;
