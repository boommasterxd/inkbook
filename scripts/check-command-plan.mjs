import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const checkProjectRoot = fileURLToPath(new URL("..", import.meta.url));

const nodeTask = (entry, ...args) => ({ entry, args });
const tasks = {
  architecture: nodeTask(
    fileURLToPath(
      new URL("../../bin/dependency-cruiser.mjs", import.meta.resolve("dependency-cruiser")),
    ),
    "--config",
    ".dependency-cruiser.mjs",
    "src",
  ),
  "audit:braces": nodeTask("scripts/verify-braces-backport.mjs"),
  "audit:dependencies": { npm: true, args: ["audit", "--audit-level=high"] },
  build: nodeTask("scripts/build.mjs"),
  "dead-code": nodeTask("scripts/run-dead-code-checks.mjs"),
  duplication: nodeTask(fileURLToPath(import.meta.resolve("jscpd/run-jscpd.js"))),
  format: nodeTask(fileURLToPath(import.meta.resolve("prettier/bin/prettier.cjs")), "--write", "."),
  "format:check": nodeTask(
    fileURLToPath(import.meta.resolve("prettier/bin/prettier.cjs")),
    "--check",
    ".",
  ),
  lint: nodeTask("node_modules/eslint/bin/eslint.js", ".", "--max-warnings", "0"),
  "lint:layout": nodeTask("scripts/verify-source-layout.mjs"),
  "lint:styles": nodeTask("node_modules/stylelint/bin/stylelint.mjs", "src/**/*.css"),
  "package:verify": nodeTask("scripts/verify-package.mjs"),
  test: nodeTask("node_modules/vitest/vitest.mjs", "run", "test/unit", "test/integration"),
  "test:coverage": nodeTask(
    "node_modules/vitest/vitest.mjs",
    "run",
    "test/unit",
    "test/integration",
    "--coverage",
  ),
  "test:integration": nodeTask("node_modules/vitest/vitest.mjs", "run", "test/integration"),
  "test:performance": nodeTask("scripts/run-performance-tests.mjs"),
  "test:unit": nodeTask("node_modules/vitest/vitest.mjs", "run", "test/unit"),
  "typecheck:runtime": nodeTask(
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "-p",
    "tsconfig.json",
  ),
  "typecheck:test": nodeTask(
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "-p",
    "test/tsconfig.json",
  ),
  "typecheck:worker": nodeTask(
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "-p",
    "tsconfig.worker.json",
  ),
};

const groups = {
  audit: ["audit:braces", "audit:dependencies"],
  benchmark: ["test:performance"],
  ci: ["ci:quality", "benchmark"],
  "ci:quality": [
    "format:check",
    "lint",
    "lint:styles",
    "lint:layout",
    "architecture",
    "typecheck",
    "typecheck:worker",
    "test:coverage",
    "duplication",
    "dead-code",
    "audit",
    "build",
    "package:verify",
  ],
  typecheck: ["typecheck:runtime", "typecheck:test"],
};

export function createCheckCommandPlan(
  name,
  extraArgs = [],
  npmEntry = process.env["npm_execpath"],
) {
  if (name === "ci" && (process.env["INKBOOK_PERFORMANCE_SUITE"] ?? "all") !== "all") {
    throw new Error("npm run ci requires performance suite all; unset shard overrides.");
  }
  const group = Object.hasOwn(groups, name) ? groups[name] : undefined;
  if (group !== undefined) {
    if (extraArgs.length > 0 && group.length > 1) {
      throw new Error(`Check group ${name} does not accept additional arguments.`);
    }
    return group.flatMap((member) => createCheckCommandPlan(member, extraArgs, npmEntry));
  }
  const task = Object.hasOwn(tasks, name) ? tasks[name] : undefined;
  if (task === undefined) throw new Error(`Unknown check: ${name}`);
  if (task.npm && (npmEntry === undefined || npmEntry === null))
    throw new Error("Run the audit through npm run.");
  return [
    {
      label: name,
      command: process.execPath,
      args: [
        task.npm ? npmEntry : resolve(checkProjectRoot, task.entry),
        ...task.args,
        ...extraArgs,
      ],
    },
  ];
}
