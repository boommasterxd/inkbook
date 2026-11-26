import { relative, resolve } from "node:path";
import { createSelection } from "./ci-selection.mjs";
import { PERFORMANCE_TEST_MANIFEST } from "./performance-test-manifest.mjs";

export function selectionOutputs(plan) {
  const selected = new Set(plan.tests);
  const contains = (files) => files.some((file) => selected.has(file));
  return {
    mode: plan.mode,
    shared: String(contains(PERFORMANCE_TEST_MANIFEST.invariant)),
    cadence: String(contains(PERFORMANCE_TEST_MANIFEST.cadenceSensitive)),
  };
}

function validateExpectedOutputs(outputs, environment) {
  for (const [name, value] of Object.entries(outputs)) {
    const expected = environment[`EXPECTED_${name.toUpperCase()}`];
    if (environment["EXPECTED_AUDIT"] === "success" && expected === undefined) {
      throw new Error("Selection audit requires complete expected selection outputs.");
    }
    if (expected !== undefined && value !== expected) {
      throw new Error(`Selection output ${name} changed: expected ${expected}, got ${value}.`);
    }
  }
}

export async function createExecutionSelection(options, environment = process.env) {
  const audit = environment["EXPECTED_AUDIT"];
  if (audit !== undefined && audit !== "success") {
    throw new Error("Selection audit did not complete successfully.");
  }
  const plan = await createSelection(options);
  validateExpectedOutputs(selectionOutputs(plan), environment);
  return plan;
}

export function selectedPerformancePlan(plan, manifestPlan, root) {
  const selected = new Set(plan.tests);
  const classified = new Set(
    Object.values(manifestPlan)
      .flat()
      .map((file) => relative(root, file).replaceAll("\\", "/")),
  );
  for (const file of selected) {
    if (file.startsWith("test/performance/") && !classified.has(file)) {
      throw new Error(`Selected performance test is not classified: ${file}`);
    }
  }
  return Object.fromEntries(
    Object.entries(manifestPlan).map(([category, files]) => [
      category,
      files.filter((file) => selected.has(relative(root, file).replaceAll("\\", "/"))),
    ]),
  );
}

export async function qualityCommands(plan, root, npmEntry, auditVerified = false) {
  if (plan.mode === "docs") throw new Error("Documentation plans have no application checks.");
  const tests = plan.tests.filter((file) => /^test\/(?:unit|integration)\//.test(file));
  if (tests.length === 0 && plan.mode === "full")
    throw new Error("Unexpected empty Unit/Integration selection.");
  const { createCheckCommandPlan } = await import("./check-command-plan.mjs");
  const commands = createCheckCommandPlan("ci:quality", [], npmEntry);
  return commands.flatMap((command) => {
    if (command.label === "audit" && auditVerified) return [];
    if (command.label !== "test" || plan.mode === "full") return [command];
    if (!tests.length) return [];
    return [
      {
        label: "test (affected)",
        command: process.execPath,
        args: [resolve(root, "scripts/run-validated-tests.mjs"), ...tests, "--", "run", ...tests],
      },
    ];
  });
}
