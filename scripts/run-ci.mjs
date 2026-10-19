import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { checkProjectRoot } from "./check-command-plan.mjs";
import { runExclusiveChecks } from "./check-execution.mjs";
import {
  assertSelectionMatches,
  qualityCommands,
  selectedPerformancePlan,
  selectionOutputs,
  validateExpectedOutputs,
} from "./ci-execution-plan.mjs";
import { createSelection, validateSelection } from "./ci-selection.mjs";
import { parseBatchReport } from "./performance-batch.mjs";
import {
  collectPerformanceTestPlan,
  reportPerformanceViolations,
  runPerformanceRuns,
  selectPerformanceRuns,
} from "./performance-test-runner.mjs";

async function validatedPlan() {
  const plan = validateSelection(
    JSON.parse(await readFile(join(checkProjectRoot, ".ci-selection.json"), "utf8")),
  );
  const expected = await createSelection({
    root: checkProjectRoot,
    base: process.env["CI_BASE"],
    head: process.env["CI_HEAD"] || "HEAD",
    forceFull: process.env["CI_EVENT"] !== "pull_request",
  });
  assertSelectionMatches(plan, expected);
  validateExpectedOutputs(selectionOutputs(plan, process.env["CI_EVENT"] !== "pull_request"));
  return plan;
}

async function quality(plan) {
  const npmEntry =
    process.env["npm_execpath"] ?? (await realpath(join(dirname(process.execPath), "npm")));
  process.stdout.write(
    plan.mode === "affected"
      ? `PARTIAL coverage: ${plan.coverage.length} runtime files; unchanged thresholds. This is not project-wide coverage.\n`
      : "Full project coverage with unchanged thresholds.\n",
  );
  if (plan.mode === "affected" && !plan.coverage.length) {
    process.stdout.write(
      "Tooling-only tests: no runtime coverage inputs; product coverage is not measured.\n",
    );
  }
  const commands = await qualityCommands(
    plan,
    checkProjectRoot,
    npmEntry,
    process.env["CI_EVENT"] !== "pull_request",
  );
  const status = await runExclusiveChecks(commands, {
    cwd: checkProjectRoot,
  });
  if (status !== 0) return status;
  const tests = plan.tests.filter((file) => /^test\/(?:unit|integration)\//.test(file));
  if (!tests.length) {
    process.stdout.write(
      "Only performance tests selected; no Unit/Integration execution planned.\n",
    );
    return 0;
  }
  const result = parseBatchReport({
    root: checkProjectRoot,
    testFiles: tests,
    refreshRate: 120,
    stdout: await readFile(join(checkProjectRoot, "coverage/ci-tests.json"), "utf8"),
  });
  for (const violation of result.violations)
    process.stderr.write(`${violation.file}: ${violation.message}\n`);
  return result.violations.length ? 1 : 0;
}

try {
  const [suite, ...extra] = process.argv.slice(2);
  if (!["quality", "shared", "cadence"].includes(suite) || extra.length)
    throw new Error("Unsupported CI suite.");
  const plan = await validatedPlan();
  if (plan.mode === "docs")
    throw new Error("Documentation plans must not start application checks.");
  // Always verify exhaustive classification, even when only a subset will run.
  const manifest = await collectPerformanceTestPlan();
  if (suite === "quality") {
    process.exitCode = await quality(plan);
  } else {
    const selected = selectedPerformancePlan(plan, manifest, checkProjectRoot);
    const runs = selectPerformanceRuns(selected, suite);
    if (runs.some(({ testFiles }) => !testFiles.length))
      throw new Error("Unexpected empty performance selection.");
    const violations = await runPerformanceRuns(runs);
    reportPerformanceViolations(violations);
    process.exitCode = violations.length ? 1 : 0;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
