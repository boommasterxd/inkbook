import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { workflowCondition } from "./workflow-condition-fixture.mjs";

const warm = readFileSync(
  new URL("../../../.github/workflows/dependency-cache.yml", import.meta.url),
  "utf8",
);
const metadata = readFileSync(
  new URL("../../../.github/workflows/cache-lifecycle.yml", import.meta.url),
  "utf8",
);
const install = readFileSync(
  new URL("../../../.github/actions/install-dependencies/action.yml", import.meta.url),
  "utf8",
);
const policy = JSON.parse(
  readFileSync(new URL("../../../scripts/cache-lifecycle/policy.json", import.meta.url), "utf8"),
);
const cleanup = warm.split("\n  cleanup:\n")[1];

it("transfers the native key and compatibility prefix into the producer receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "inkbook-cache-receipt-"));
  const output = join(directory, "output");
  const key = `npm-v1-Linux-X64-node26-npm11-${"a".repeat(64)}-${"b".repeat(64)}`;
  const prefix = key.slice(0, -64);
  const script = warm.match(/node --input-type=module <<'NODE'\n([\s\S]+?)\n {10}NODE/)?.[1];
  expect(script).toBeTruthy();
  try {
    execFileSync(process.execPath, ["--input-type=module"], {
      input: script,
      env: {
        ...process.env,
        CACHE_PRIMARY_KEY: key,
        CACHE_PREFIX: prefix,
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: directory,
      },
      timeout: 5_000,
    });
    const receipt = readFileSync(output, "utf8");
    expect(receipt).toBe(`replacements=${JSON.stringify([{ family: "npm", key, prefix }])}\n`);
    expect(JSON.parse(readFileSync(join(directory, "replacements.json"), "utf8"))).toEqual([
      { family: "npm", key, prefix },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("cache lifecycle integration", () => {
  it("publishes the native producer identity only after the complete dependency installation", () => {
    expect(install).toContain("value: ${{ steps.restore.outputs.cache-primary-key }}");
    expect(install).toContain(
      "value: npm-v1-${{ runner.os }}-${{ runner.arch }}-${{ steps.identity.outputs.compatibility }}-${{ hashFiles('.npmrc') }}-",
    );
    expect(warm).toContain("replacements: ${{ steps.receipt.outputs.replacements }}");
    expect(warm.indexOf("- name: Publish native replacement identity")).toBeGreaterThan(
      warm.indexOf("uses: ./.github/actions/install-dependencies"),
    );
    expect(cleanup).toContain("needs: warm");
    expect(cleanup).toContain("CACHE_REPLACEMENTS: ${{ needs.warm.outputs.replacements }}");
    expect(cleanup).not.toContain("hashFiles(");
    expect(warm).toContain("name: cache-lifecycle-receipts-${{ github.run_attempt }}");
    expect(warm).toContain("path: ${{ runner.temp }}/replacements.json");
    expect(warm).toContain("retention-days: 7\n          if-no-files-found: error");
  });

  it("admits dependency pruning only after successful trusted main production", () => {
    const condition = cleanup.match(/if: >-\n((?: {6}.+\n)+)/)?.[1].trim();
    expect(condition).toBeTruthy();
    const context = {
      needs: { warm: { result: "success" } },
      github: { ref: "refs/heads/main", event: { repository: { default_branch: "main" } } },
    };
    expect(workflowCondition(condition, context)).toBe(true);
    for (const result of ["failure", "cancelled", "skipped"]) {
      expect(workflowCondition(condition, { ...context, needs: { warm: { result } } })).toBe(false);
    }
    context.github.ref = "refs/pull/42/merge";
    expect(workflowCondition(condition, context)).toBe(false);
    context.github.ref = "refs/heads/main";
    context.github.event.repository.default_branch = "other";
    expect(workflowCondition(condition, context)).toBe(false);
  });

  it("keeps privileged cleanup on trusted code without installation or cache writes", () => {
    for (const workflow of [cleanup, metadata]) {
      expect(workflow).toContain("ref: refs/heads/main");
      expect(workflow).toContain("persist-credentials: false");
      expect(workflow).toContain('node-version: "26.x"\n          check-latest: true');
      expect(workflow).toContain("package-manager-cache: false");
      expect(workflow).toContain("group: cache-lifecycle\n      cancel-in-progress: false");
      expect(workflow).toContain("contents: read\n      actions: write");
      expect(workflow).toContain("      actions: write\n      pull-requests: read");
      expect(workflow).toContain(
        "run: node scripts/cache-lifecycle/run.cjs scripts/cache-lifecycle/policy.json",
      );
      expect(workflow).not.toMatch(/npm ci|actions\/cache|head_sha|pull_request.head/);
    }
    expect(warm.split("\njobs:\n")[0]).not.toContain("actions: write");
    expect(metadata.split("\njobs:\n")[0]).not.toContain("actions: write");
    expect(metadata).toContain("pull_request_target:\n    types: [closed]");
    expect(metadata).toContain("types: [completed]");
    expect(metadata).not.toContain("schedule:");
  });

  it("limits producer provenance to the actual npm and managed CodeQL workflows", () => {
    expect(policy.repository).toBe("boommasterxd/inkbook");
    expect(policy.defaultBranch).toBe("main");
    expect(policy.producerWorkflows).toEqual([
      {
        name: "Warm dependency cache",
        path: ".github/workflows/dependency-cache.yml",
        job: "warm",
      },
    ]);
    expect(policy.codeqlWorkflows).toEqual([
      { name: "Push on main", path: "dynamic/github-code-scanning/codeql" },
    ]);
    expect(policy.families).toEqual({ npm: "npm-v1-" });
    expect(policy.retiredPrefixes).toEqual([]);
    expect(policy.producerInputs).toEqual([
      "package.json",
      "package-lock.json",
      ".npmrc",
      ".nvmrc",
      ".github/actions/",
      ".github/workflows/dependency-cache.yml",
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
    ]);
    for (const input of policy.producerInputs) {
      expect(warm).toContain(`      - ${input.endsWith("/") ? `${input}**` : input}\n`);
    }
  });
});

it("resumes deferred cleanup after every workflow that can block it completes", () => {
  const directory = fileURLToPath(new URL("../../../.github/workflows/", import.meta.url));
  const sourceNames = readdirSync(directory)
    .filter((file) => /\.ya?ml$/.test(file) && file !== "cache-lifecycle.yml")
    .map((file) => readFileSync(join(directory, file), "utf8").match(/^name: (.+)$/m)?.[1]);
  expect(sourceNames.every(Boolean)).toBe(true);
  const admitted = metadata.match(/ {4}workflows:\n((?: {6}- .+\n)+)/)?.[1];
  expect(admitted).toBeTruthy();
  expect(
    admitted
      .trim()
      .split(/\n/)
      .map((line) => line.trim().slice(2))
      .sort(),
  ).toEqual([...sourceNames, "Push on main"].sort());
});
