import {
  collectTestFiles,
  reportPerformanceViolations,
  runRefreshRateMatrix,
} from "./performance-test-runner.mjs";

const refreshRates = [60, 90, 120, 144, 240];
const violations = await runRefreshRateMatrix(await collectTestFiles(), refreshRates);
reportPerformanceViolations(violations);
if (violations.length > 0) process.exitCode = 1;
