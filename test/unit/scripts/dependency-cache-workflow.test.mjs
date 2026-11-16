import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workflowCondition } from "./workflow-condition-fixture.mjs";

const workflowDirectory = new URL("../../../.github/workflows/", import.meta.url);
const action = readFileSync(
  new URL("../../../.github/actions/install-dependencies/action.yml", import.meta.url),
  "utf8",
);
const warmup = readFileSync(new URL("dependency-cache.yml", workflowDirectory), "utf8");
const actionSteps = action.split(/^ {4}- name: /m).slice(1);
const restore = actionSteps.find((step) => step.startsWith("Restore npm downloads\n"));
const install = actionSteps.find((step) => step.startsWith("Install the complete locked"));
const save = actionSteps.find((step) => step.startsWith("Save trusted npm downloads\n"));

describe("shared dependency installation", () => {
  it("routes every npm consumer through the shared installer without overlapping automatic caches", () => {
    const consumers = [];
    const metadataOnly = [];
    for (const filename of readdirSync(workflowDirectory).filter((file) => file.endsWith(".yml"))) {
      const workflow = readFileSync(new URL(filename, workflowDirectory), "utf8");
      expect(workflow, filename).not.toMatch(/\brun:.*npm (?:ci|install)\b/);
      for (const job of workflow.split(/^ {2}[\w-]+:\n/m).slice(1)) {
        const setups = [
          ...job.matchAll(/uses: actions\/setup-node@[^\n]+([\s\S]*?)(?=\n {6}- name:|$)/g),
        ];
        const installers = job.match(/uses: \.\/\.github\/actions\/install-dependencies/g) ?? [];
        if (!setups.length && !installers.length) continue;
        expect(setups, filename).toHaveLength(1);
        expect(setups[0][1]).toContain("package-manager-cache: false");
        expect(setups[0][1]).not.toMatch(/^\s+cache:/m);
        if (!installers.length) {
          expect(job).toContain(
            "run: node scripts/cache-lifecycle/run.cjs scripts/cache-lifecycle/policy.json",
          );
          expect(job).toContain("ref: refs/heads/main");
          expect(job).toContain("contents: read\n      actions: write\n      pull-requests: read");
          metadataOnly.push(filename);
          continue;
        }
        expect(installers, filename).toHaveLength(1);
        if (filename !== "dependency-cache.yml") expect(job).not.toContain('save-cache: "true"');
        consumers.push(filename);
      }
    }
    expect(consumers.sort()).toEqual([
      "ci.yml",
      "ci.yml",
      "ci.yml",
      "dependency-cache.yml",
      "release.yml",
    ]);
    expect(metadataOnly.sort()).toEqual(["cache-lifecycle.yml", "dependency-cache.yml"]);
  });

  it("restores and saves the same compatible download store while always enforcing the lockfile", () => {
    expect(restore).toContain("uses: actions/cache/restore@");
    expect(save).toContain("uses: actions/cache/save@");
    const path = restore.match(/^ {8}path: (.+)$/m)?.[1];
    expect(path).toBe("~/.npm/_cacache");
    expect(save.match(/^ {8}path: (.+)$/m)?.[1]).toBe(path);
    const key = restore.match(/^ {8}key: (.+)$/m)?.[1];
    expect(key).toBe("${{ steps.identity.outputs.prefix }}${{ hashFiles('package-lock.json') }}");
    expect(actionSteps[0]).toContain("INSTALL_CONFIG_HASH: ${{ hashFiles('.npmrc') }}");
    expect(actionSteps[0]).toContain('"$RUNNER_OS" "$RUNNER_ARCH"');
    expect(key).not.toMatch(/github\.(?:sha|ref)|pull_request/);
    expect(restore.match(/^ {8}restore-keys: (.+)$/m)?.[1]).toBe(
      key.replace("${{ hashFiles('package-lock.json') }}", ""),
    );
    expect(save).toContain("key: ${{ steps.restore.outputs.cache-primary-key }}");
    expect(actionSteps[0]).toContain("prefix=npm-v1-%s-%s-node%s-npm%s-%s-");
    expect(actionSteps[0]).toContain('"$node_major" "${npm_version%%.*}" "$INSTALL_CONFIG_HASH"');
    expect(restore).toContain("continue-on-error: true");
    expect(save).toContain("continue-on-error: true");
    expect(install).toContain(
      'npm ci --include=dev --prefer-offline --no-audit --cache "$HOME/.npm"',
    );
    expect(install).not.toMatch(/^\s+(?:if|continue-on-error):/m);
    expect(action.indexOf(restore)).toBeLessThan(action.indexOf(install));
    expect(action.indexOf(install)).toBeLessThan(action.indexOf(save));
  });
});

function saveAllowed(overrides = {}) {
  const context = {
    inputs: { "save-cache": "true" },
    github: {
      ref: "refs/heads/main",
      event_name: "push",
      event: { repository: { default_branch: "main" } },
    },
    steps: { restore: { outputs: { "cache-hit": "false" } } },
  };
  for (const [field, value] of Object.entries(overrides)) {
    if (field === "requested") context.inputs["save-cache"] = value;
    else if (field === "hit") context.steps.restore.outputs["cache-hit"] = value;
    else if (field === "default_branch") context.github.event.repository.default_branch = value;
    else context.github[field] = value;
  }
  // Normalize GitHub hyphenated identifiers and inequality to the existing
  // fixture's deliberately limited TypeScript boolean expression subset.
  const expression = save
    .match(/ {6}if: >-\n([\s\S]*?)\n {6}uses:/)[1]
    .trim()
    .replaceAll(/\s+/g, " ")
    .replaceAll("inputs.save-cache", "inputs['save-cache']")
    .replaceAll("outputs.cache-hit", "outputs['cache-hit']")
    .replace(
      "steps.restore.outputs['cache-hit'] != 'true'",
      "(steps.restore.outputs['cache-hit'] == 'true') == false",
    );
  return workflowCondition(expression, context);
}

describe("trusted default-branch cache writer", () => {
  it("permits requested main pushes and manual warmups only after a miss", () => {
    expect(saveAllowed()).toBe(true);
    expect(saveAllowed({ event_name: "workflow_dispatch" })).toBe(true);
    expect(saveAllowed({ hit: "true" })).toBe(false);
    expect(saveAllowed({ requested: "false" })).toBe(false);
    expect(action).toContain('default: "false"');
  });

  it.each([
    { event_name: "pull_request", ref: "refs/pull/123/merge" },
    { event_name: "pull_request_target" },
    { event_name: "workflow_run" },
    { event_name: "workflow_dispatch", ref: "refs/heads/feature" },
    { ref: "refs/tags/1.0.0" },
    { default_branch: "other" },
  ])("rejects an untrusted write opportunity: %j", (context) => {
    expect(saveAllowed(context)).toBe(false);
  });

  it("warms only for main dependency and setup changes without repeating project gates", () => {
    const triggers = warmup.split("\non:\n")[1].split("\nconcurrency:\n")[0];
    expect(triggers).toContain("push:\n    branches: [main]");
    expect(triggers).toContain("workflow_dispatch:");
    const paths = [...triggers.matchAll(/^ {6}- (.+)$/gm)].map((match) => match[1]);
    expect(paths.sort()).toEqual([
      ".github/actions/**",
      ".github/workflows/ci.yml",
      ".github/workflows/dependency-cache.yml",
      ".github/workflows/release.yml",
      ".npmrc",
      ".nvmrc",
      "package-lock.json",
      "package.json",
      "scripts/cache-lifecycle/**",
    ]);
    expect(warmup).toContain("permissions:\n  contents: read");
    expect(warmup).toContain("persist-credentials: false");
    expect(warmup).toContain('save-cache: "true"');
    const producer = warmup.split("\n  cleanup:\n")[0];
    expect(producer).not.toMatch(
      /secrets\.|pull_request_target|workflow_run|schedule:|npm run|gh release|gitleaks/,
    );
  });
});

describe("manual warmup branch admission", () => {
  let directory;
  let script;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "inkbook-cache-guard-"));
    script = join(directory, "guard.sh");
    const guard = warmup.match(/^ {8}run: (.+)$/m)?.[1];
    expect(guard).toBeTruthy();
    writeFileSync(script, `${guard}\n`, { flag: "wx", mode: 0o600 });
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it.each([
    ["refs/heads/main", "main", 0],
    ["refs/heads/feature", "main", 1],
    ["refs/tags/1.0.0", "main", 1],
    ["refs/heads/main", "other", 1],
  ])("checks %s against default branch %s before checkout", (ref, defaultBranch, status) => {
    const result = spawnSync("bash", ["--noprofile", "--norc", script], {
      env: { ...process.env, GITHUB_REF: ref, DEFAULT_BRANCH: defaultBranch },
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    expect(warmup.indexOf("Require the trusted default branch")).toBeLessThan(
      warmup.indexOf("uses: actions/checkout@"),
    );
  });
});
