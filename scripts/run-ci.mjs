import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { checkProjectRoot } from "./check-command-plan.mjs";
import { runExclusiveChecks } from "./check-execution.mjs";
import {
  createExecutionSelection,
  qualityCommands,
  selectedPerformancePlan,
} from "./ci-execution-plan.mjs";
import {
  collectPerformanceTestPlan,
  reportPerformanceViolations,
  runPerformanceRuns,
  selectPerformanceRuns,
} from "./performance-test-runner.mjs";

function validatedPlan() {
  return createExecutionSelection({
    root: checkProjectRoot,
    base: process.env["CI_BASE"],
    head: process.env["CI_HEAD"] || "HEAD",
    merge: process.env["CI_MERGE"],
    forceFull: process.env["CI_EVENT"] !== "pull_request",
  });
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
    process.env["EXPECTED_AUDIT"] === "success",
  );
  return runExclusiveChecks(commands, {
    cwd: checkProjectRoot,
  });
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
