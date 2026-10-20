import { relative, resolve } from "node:path";
import { createSelection } from "./ci-selection.mjs";
import { PERFORMANCE_TEST_MANIFEST } from "./performance-test-manifest.mjs";

const NON_PRODUCTION = [
  /^docs\/.*\.md$/,
  /^(?:AGENTS|README|CONTRIBUTING|CHANGELOG|SECURITY|LICENSE)\.md$/,
  /^test\//,
  /^\.github\//,
  /^\.gitignore$/,
  /^scripts\/(?:ci-[\w-]+|run-ci|check-command-plan|check-execution|run-checks|run-dead-code-checks|run-validated-tests|verify-source-layout|verify-work-scheduling|performance-[\w-]+|run-performance-tests)\.mjs$/,
  /^(?:vitest\.config\.ts|tsconfig\.(?:test|tooling)\.json|knip\.json|eslint\.config\.mjs|stylelint\.config\.mjs|\.jscpd\.json|\.gitleaks(?:\.toml|-version)|\.prettierignore|\.prettierrc(?:\.json)?|\.dependency-cruiser\.mjs)$/,
];

export function selectionOutputs(plan, forceFull = false) {
  const selected = new Set(plan.tests);
  const contains = (files) => files.some((file) => selected.has(file));
  return {
    mode: plan.mode,
    shared: String(contains(PERFORMANCE_TEST_MANIFEST.invariant)),
    cadence: String(contains(PERFORMANCE_TEST_MANIFEST.cadenceSensitive)),
    build: String(
      plan.mode !== "docs" &&
        (forceFull ||
          plan.changes.length === 0 ||
          plan.changes.some((file) => !NON_PRODUCTION.some((pattern) => pattern.test(file)))),
    ),
  };
}

export function validateExpectedOutputs(outputs, environment = process.env) {
  for (const [name, value] of Object.entries(outputs)) {
    const expected = environment[`EXPECTED_${name.toUpperCase()}`];
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
  if (
    audit === "success" &&
    ["MODE", "SHARED", "CADENCE", "BUILD"].some(
      (name) => environment[`EXPECTED_${name}`] === undefined,
    )
  ) {
    throw new Error("Selection audit requires complete expected selection outputs.");
  }
  const plan = await createSelection(options);
  validateExpectedOutputs(selectionOutputs(plan, options.forceFull), environment);
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

export async function qualityCommands(
  plan,
  root,
  npmEntry,
  forceFull = false,
  auditVerified = false,
) {
  if (plan.mode === "docs") throw new Error("Documentation plans have no application checks.");
  const tests = plan.tests.filter((file) => /^test\/(?:unit|integration)\//.test(file));
  if (tests.length === 0 && (plan.mode === "full" || !plan.tests.length || plan.coverage.length))
    throw new Error("Unexpected empty Unit/Integration selection.");
  const { createCheckCommandPlan } = await import("./check-command-plan.mjs");
  const commands = createCheckCommandPlan("ci:quality", [], npmEntry);
  return commands.flatMap((command) => {
    if (command.label === "audit" && auditVerified) return [];
    if (
      ["build", "package:verify"].includes(command.label) &&
      selectionOutputs(plan, forceFull).build === "false"
    )
      return [];
    if (command.label !== "test:coverage") return [command];
    if (!tests.length) return [];
    const coverage = plan.mode === "full" ? ["src/**/*.{ts,tsx}"] : plan.coverage;
    return [
      {
        label: `test:coverage (${plan.mode === "full" ? "full" : "partial"})`,
        command: process.execPath,
        args: [
          resolve(root, "scripts/run-validated-tests.mjs"),
          ...tests,
          "--",
          "run",
          ...tests,
          ...(coverage.length
            ? ["--coverage", ...coverage.map((file) => `--coverage.include=${file}`)]
            : []),
        ],
      },
    ];
  });
}
