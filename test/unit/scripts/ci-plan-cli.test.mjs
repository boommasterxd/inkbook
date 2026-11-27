import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

import { cleanupRepositories, commit, createRepository } from "./ci-selection-fixtures.mjs";

const execute = promisify(execFile);
const scripts = [
  "check-execution",
  "ci-plan",
  "ci-runner-output",
  "ci-documentation",
  "ci-execution-plan",
  "ci-selection",
  "ci-selection-git",
  "ci-selection-graph",
  "performance-test-runner",
  "performance-gate",
  "performance-batch",
];
const tooling = Object.fromEntries(
  await Promise.all(
    scripts.map(async (name) => {
      const file = `scripts/${name}.mjs`;
      return [file, await readFile(new URL(`../../../${file}`, import.meta.url), "utf8")];
    }),
  ),
);

afterEach(cleanupRepositories);

async function fixture() {
  const context = await createRepository({
    ...tooling,
    ".gitignore": "runner-temp/\n",
    "scripts/performance-test-manifest.mjs":
      'export const PERFORMANCE_TEST_MANIFEST = { invariant: ["test/performance/invariant.test.ts"], cadenceSensitive: ["test/performance/cadence.test.ts"] };',
    "docs/example.md": "# Example\n",
    "docs/README.md":
      "# Documentation\n\n## Documentation Index\n\n| Document | Purpose |\n| --- | --- |\n| [`docs/README.md`](README.md) | Lists documentation. |\n| [`docs/example.md`](example.md) | Explains the example. |\n",
    "AGENTS.md": "# Instructions\n",
    "README.md": "[Example](docs/example.md)\n",
    "CONTRIBUTING.md": "# Contributing\n",
    "SECURITY.md": "# Security Policy\n",
    "test/unit/example.test.ts": "export {};",
    "test/performance/invariant.test.ts": "export {};",
    "test/performance/cadence.test.ts": "export {};",
  });
  const runnerTemp = path.join(context.root, "runner-temp");
  const commands = path.join(runnerTemp, "_runner_file_commands");
  await mkdir(commands, { recursive: true });
  const output = path.join(commands, "set_output_test-step-1");
  await writeFile(output, "existing=retained\n");
  return { ...context, runnerTemp, output };
}

function run(context, args = [], overrides = {}) {
  return execute(process.execPath, [path.join(context.root, "scripts/ci-plan.mjs"), ...args], {
    cwd: context.root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      EXPECTED_MODE: undefined,
      EXPECTED_SHARED: undefined,
      EXPECTED_CADENCE: undefined,
      EXPECTED_AUDIT: undefined,
      CI_BASE: context.base,
      CI_HEAD: "HEAD",
      CI_MERGE: undefined,
      CI_EVENT: "pull_request",
      RUNNER_TEMP: context.runnerTemp,
      GITHUB_OUTPUT: context.output,
      GITHUB_STEP_SUMMARY: undefined,
      ...overrides,
    },
  });
}

it("publishes a validated docs-only plan without installing dependencies", async () => {
  const context = await fixture();
  await commit(context.root, { "docs/example.md": "# Updated\n\n[Readme](../README.md)\n" });

  expect((await run(context, ["--preflight"])).stdout).toContain("docs=true");
  expect((await run(context)).stdout).toContain("mode=docs");
  expect(await readFile(context.output, "utf8")).toBe(
    "existing=retained\ndocs=true\nmode=docs\nshared=false\ncadence=false\n",
  );
});

it("executes the full path for a manual run even when only documentation changed", async () => {
  const context = await fixture();
  await commit(context.root, { "docs/example.md": "# Updated\n" });
  const environment = { CI_EVENT: "workflow_dispatch" };

  expect((await run(context, ["--preflight"], environment)).stdout).toContain("docs=false");
  expect((await run(context, [], environment)).stdout).toContain("mode=full");
});

it("fails before publishing a docs-only plan with an invalid link", async () => {
  const context = await fixture();
  await commit(context.root, { "docs/example.md": '<a href="README.md#missing">Missing</a>\n' });

  await expect(run(context)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Broken relative documentation link"),
  });
  expect(await readFile(context.output, "utf8")).toBe("existing=retained\n");
});

it("rejects a performance test missing from the manifest", async () => {
  const context = await fixture();
  await commit(context.root, { "test/performance/unclassified.test.ts": "export {};" });

  await expect(run(context)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Unclassified performance tests"),
  });
});
