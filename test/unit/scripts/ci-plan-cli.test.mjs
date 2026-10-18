import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupRepositories, commit, createRepository } from "./ci-selection-fixtures.mjs";

const execute = promisify(execFile);
const scripts = [
  "ci-plan",
  "ci-documentation",
  "ci-execution-plan",
  "ci-selection",
  "ci-selection-git",
  "ci-selection-graph",
  "performance-test-manifest",
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
  return createRepository({
    ...tooling,
    "scripts/performance-test-manifest.mjs":
      'export const PERFORMANCE_TEST_MANIFEST = { invariant: ["test/performance/invariant.test.ts"], cadenceSensitive: ["test/performance/cadence.test.ts"] };',
    "docs/example.md": "# Example\n",
    "AGENTS.md":
      "# Instructions\n\n## Documentation Index\n\n| Document | Purpose |\n| --- | --- |\n| [Example](docs/example.md) | Example |\n",
    "README.md": "[Example](docs/example.md)\n",
    "test/unit/example.test.ts": "export {};",
    "test/performance/invariant.test.ts": "export {};",
    "test/performance/cadence.test.ts": "export {};",
  });
}

function run(context, args = [], overrides = {}) {
  return execute(process.execPath, [path.join(context.root, "scripts/ci-plan.mjs"), ...args], {
    cwd: context.root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      CI_BASE: context.base,
      CI_HEAD: "HEAD",
      CI_EVENT: "pull_request",
      GITHUB_OUTPUT: path.join(context.root, "github-output"),
      GITHUB_STEP_SUMMARY: path.join(context.root, "github-summary"),
      ...overrides,
    },
  });
}

describe("CI planner entrypoint", () => {
  it("validates a docs-only PR and publishes a real plan without installed dependencies", async () => {
    const context = await fixture();
    await commit(context.root, {
      "docs/example.md": "# Updated\n\n[Readme](../README.md)\n\n`[example](missing.svg)`\n",
    });
    expect((await run(context, ["--preflight"])).stdout).toContain("docs=true");
    const result = await run(context);
    expect(result.stdout).toContain("mode=docs");
    expect(await readFile(path.join(context.root, "github-output"), "utf8")).toContain(
      "mode=docs\nshared=false\ncadence=false\nbuild=false\n",
    );
    expect(
      JSON.parse(await readFile(path.join(context.root, ".ci-selection.json"), "utf8")),
    ).toMatchObject({
      mode: "docs",
      changes: ["docs/example.md"],
      tests: [],
      coverage: [],
    });
    expect(await readFile(path.join(context.root, "github-summary"), "utf8")).toContain("**docs**");
  });

  it("runs full verification rather than the docs shortcut when history is unavailable", async () => {
    const context = await fixture();
    await commit(context.root, { "docs/example.md": "# Updated\n" });
    expect((await run(context, ["--preflight"], { CI_BASE: "missing" })).stdout).toContain(
      "docs=false",
    );
    const result = await run(context, [], { CI_BASE: "missing" });
    expect(result.stdout).toContain("mode=full");
    expect(result.stdout).toContain("build=true");
  });

  it("never uses the docs shortcut for manual dispatches", async () => {
    const context = await fixture();
    await commit(context.root, { "docs/example.md": "# Updated\n" });
    expect(
      (await run(context, ["--preflight"], { CI_EVENT: "workflow_dispatch" })).stdout,
    ).toContain("docs=false");
    expect((await run(context, [], { CI_EVENT: "workflow_dispatch" })).stdout).toContain(
      "mode=full",
    );
  });

  it.each([
    ["a broken link", "[Missing](missing.md)\n", "Broken relative Markdown link"],
    ["unbalanced fences", "```ts\nconst x = 1;\n", "Unclosed Markdown fence"],
  ])("fails the docs gate for %s", async (_label, content, error) => {
    const context = await fixture();
    await commit(context.root, { "docs/example.md": content });
    await expect(run(context)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(error),
    });
  });

  it.each(["tsx", "mjs"])(
    "fails detection before publishing unclassified performance .%s tests",
    async (extension) => {
      const context = await fixture();
      await commit(context.root, {
        [`test/performance/unclassified.test.${extension}`]: "export {};",
      });
      await expect(run(context)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Unclassified performance tests"),
      });
    },
  );

  it("rejects stale detector expectations before publishing a plan", async () => {
    const context = await fixture();
    await commit(context.root, { "docs/example.md": "# Updated\n" });
    await expect(run(context, [], { EXPECTED_MODE: "affected" })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Selection output mode changed"),
    });
  });
});
