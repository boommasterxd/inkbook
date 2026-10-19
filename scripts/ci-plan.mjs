import { appendFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { validateDocumentation } from "./ci-documentation.mjs";
import { selectionOutputs, validateExpectedOutputs } from "./ci-execution-plan.mjs";
import { createSelection, inspectChanges } from "./ci-selection.mjs";
import { collectPerformanceTestPlan } from "./performance-test-runner.mjs";

const checkProjectRoot = fileURLToPath(new URL("..", import.meta.url));

async function publishOutputs(outputs) {
  const output = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  if (process.env["GITHUB_OUTPUT"]) await appendFile(process.env["GITHUB_OUTPUT"], output);
  process.stdout.write(output);
}

async function preflight(options) {
  let docs = false;
  if (!options.forceFull) {
    try {
      const { changes } = await inspectChanges(options);
      docs = changes.length > 0 && changes.every((file) => /^docs\/.*\.md$/.test(file));
    } catch {
      // The installed planner will record missing history and request the full gate.
    }
  }
  await publishOutputs({ docs: String(docs) });
}

try {
  const options = {
    root: checkProjectRoot,
    base: process.env["CI_BASE"],
    head: process.env["CI_HEAD"] || "HEAD",
    forceFull: process.env["CI_EVENT"] !== "pull_request",
  };
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--preflight") {
    await preflight(options);
  } else {
    if (args.length) throw new Error("Unsupported CI planner arguments.");
    const plan = await createSelection(options);
    if (plan.mode === "docs") await validateDocumentation(checkProjectRoot);
    else await collectPerformanceTestPlan();
    const outputs = selectionOutputs(plan, options.forceFull);
    validateExpectedOutputs(outputs);
    await writeFile(`${checkProjectRoot}/.ci-selection.json`, JSON.stringify(plan, null, 2) + "\n");
    process.stdout.write(
      `${plan.reason}\n${plan.tests.length} selected test files; ${plan.coverage.length} coverage inputs.\n`,
    );
    await publishOutputs(outputs);
    if (process.env["GITHUB_STEP_SUMMARY"]) {
      await appendFile(
        process.env["GITHUB_STEP_SUMMARY"],
        `Selection: **${plan.mode}**. ${plan.reason}\n\n${plan.tests.length} selected test files. ` +
          `Coverage: ${plan.mode === "affected" ? "partial, selected runtime dependency closure" : plan.mode}. ` +
          `Build: ${outputs.build}.\n`,
      );
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
