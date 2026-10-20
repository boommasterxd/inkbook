import { execFile } from "node:child_process";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCheckCommandPlan } from "../../../scripts/check-command-plan.mjs";
import { cleanupRepositories, commit, createRepository } from "./ci-selection-fixtures.mjs";

const execute = promisify(execFile);
const scripts = [
  "ci-plan",
  "run-ci",
  "check-command-plan",
  "check-execution",
  "ci-runner-output",
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
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.stubEnv("EXPECTED_MODE", "full");
  vi.stubEnv("EXPECTED_SHARED", "true");
  vi.stubEnv("EXPECTED_CADENCE", "true");
  vi.stubEnv("EXPECTED_BUILD", "false");
});

async function fixture() {
  const context = await createRepository({
    ...tooling,
    ".gitignore": "runner-temp/\n",
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
  const runnerTemp = path.join(context.root, "runner-temp");
  const commands = path.join(runnerTemp, "_runner_file_commands");
  await mkdir(commands, { recursive: true });
  const output = path.join(commands, "set_output_test-step-1");
  const summary = path.join(commands, "step_summary_test-step-1");
  await Promise.all([
    writeFile(output, "existing=retained\n"),
    writeFile(summary, "Existing summary\n"),
  ]);
  return { ...context, runnerTemp, commands, output, summary };
}

function run(context, args = [], overrides = {}, entry = "ci-plan") {
  return execute(process.execPath, [path.join(context.root, `scripts/${entry}.mjs`), ...args], {
    cwd: context.root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      EXPECTED_MODE: undefined,
      EXPECTED_SHARED: undefined,
      EXPECTED_CADENCE: undefined,
      EXPECTED_BUILD: undefined,
      EXPECTED_AUDIT: undefined,
      CI_BASE: context.base,
      CI_HEAD: "HEAD",
      CI_MERGE: undefined,
      CI_EVENT: "pull_request",
      RUNNER_TEMP: context.runnerTemp,
      GITHUB_OUTPUT: context.output,
      GITHUB_STEP_SUMMARY: context.summary,
      ...overrides,
    },
  });
}

describe("CI planner entrypoint with inherited CI expectations", () => {
  it("validates a docs-only PR and publishes a real plan without installed dependencies", async () => {
    const context = await fixture();
    await commit(context.root, {
      "docs/example.md": "# Updated\n\n[Readme](../README.md)\n\n`[example](missing.svg)`\n",
    });
    expect((await run(context, ["--preflight"])).stdout).toContain("docs=true");
    const result = await run(context);
    expect(result.stdout).toContain("mode=docs");
    expect(await readFile(context.output, "utf8")).toBe(
      "existing=retained\ndocs=true\nmode=docs\nshared=false\ncadence=false\nbuild=false\n",
    );
    expect(await readFile(context.summary, "utf8")).toMatch(
      /^Existing summary\nSelection: \*\*docs\*\*/,
    );
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
    await expect(run(context, [], { CI_MERGE: context.base })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("expected merge revision"),
    });
  });

  it("recomputes an active consumer selection without trusting a serialized plan", async () => {
    const context = await fixture();
    await commit(context.root, { "test/unit/example.test.ts": "export const changed = true;" });
    await symlink(
      fileURLToPath(new URL("../../../node_modules", import.meta.url)),
      path.join(context.root, "node_modules"),
      "dir",
    );
    await writeFile(path.join(context.root, ".ci-selection.json"), "malformed legacy plan");
    await expect(run(context, ["shared"], {}, "run-ci")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Unexpected empty performance selection"),
    });
    await expect(
      run(context, ["shared"], { EXPECTED_SHARED: "true" }, "run-ci"),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Selection output shared changed"),
    });
  });
});

describe("regular documentation quality gate", () => {
  it.each([
    [
      "mixed code and documentation changes",
      { "docs/example.md": "[Missing](missing.md)\n", "src/domain/example.ts": "export {};" },
      "Broken relative Markdown link",
    ],
    ["README changes", { "README.md": "[Missing](missing.md)\n" }, "Broken relative Markdown link"],
    ["instruction changes", { "AGENTS.md": "# Instructions\n" }, "Missing Documentation Index"],
  ])("rejects invalid %s through the regular gate command", async (_label, changes, error) => {
    const context = await fixture();
    await commit(context.root, changes);
    const [check] = createCheckCommandPlan("ci:quality", [], "/npm-cli.js");
    expect(check.label).toBe("docs:check");
    await expect(
      execute(check.command, check.args, {
        cwd: context.root,
        encoding: "utf8",
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(error) });
  });
});

describe("CI planner runner file command boundaries", () => {
  it.each([
    ["GITHUB_OUTPUT", "set_output_"],
    ["GITHUB_STEP_SUMMARY", "step_summary_"],
  ])("rejects unsafe %s targets without modifying their destinations", async (variable, prefix) => {
    const context = await fixture();
    await commit(context.root, { "docs/example.md": "# Updated\n" });
    const victim = path.join(context.runnerTemp, `${prefix}victim`);
    const sibling = `${context.commands}-sibling`;
    const directory = path.join(context.commands, `${prefix}directory`);
    const symbolic = path.join(context.commands, `${prefix}symbolic`);
    const hard = path.join(context.commands, `${prefix}hard`);
    await Promise.all([mkdir(sibling), mkdir(directory), writeFile(victim, "untouched\n")]);
    const siblingFile = path.join(sibling, `${prefix}victim`);
    await writeFile(siblingFile, "untouched\n");
    await symlink(victim, symbolic);
    await link(victim, hard);
    const targets = [
      victim,
      `${context.commands}${path.sep}..${path.sep}${prefix}victim`,
      siblingFile,
      path.relative(context.root, variable === "GITHUB_OUTPUT" ? context.output : context.summary),
      variable === "GITHUB_OUTPUT" ? context.summary : context.output,
      path.join(context.commands, `${prefix}missing`),
      directory,
      symbolic,
      hard,
    ];
    for (const target of targets) {
      await expect(run(context, [], { [variable]: target })).rejects.toMatchObject({ code: 1 });
      expect(await readFile(victim, "utf8")).toBe("untouched\n");
      expect(await readFile(siblingFile, "utf8")).toBe("untouched\n");
    }
    await expect(readFile(targets[5], "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a command directory redirected outside the runner temporary root", async () => {
    const context = await fixture();
    const directory = path.join(context.root, "redirected-commands");
    await mkdir(directory);
    const victim = path.join(directory, "set_output_victim");
    await writeFile(victim, "untouched\n");
    const temporary = path.join(context.runnerTemp, "redirected-temp");
    await mkdir(temporary);
    const linkedCommands = path.join(temporary, "_runner_file_commands");
    await symlink(directory, linkedCommands, "dir");
    await expect(
      run(context, ["--preflight"], {
        RUNNER_TEMP: temporary,
        GITHUB_OUTPUT: path.join(linkedCommands, "set_output_victim"),
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(await readFile(victim, "utf8")).toBe("untouched\n");
  });

  it("requires the runner temporary root only when publishing file commands", async () => {
    const context = await fixture();
    await expect(run(context, ["--preflight"], { RUNNER_TEMP: undefined })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Invalid runner file command configuration"),
    });
    expect(
      (
        await run(context, ["--preflight"], {
          RUNNER_TEMP: undefined,
          GITHUB_OUTPUT: undefined,
          GITHUB_STEP_SUMMARY: undefined,
        })
      ).stdout,
    ).toContain("docs=false");
  });
});
