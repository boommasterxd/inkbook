import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

function readWorkflow(name) {
  return readFileSync(new URL(`../../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
}

function jobSection(workflow, id) {
  const section = workflow.split(`\n  ${id}:\n`)[1];
  if (section === undefined) throw new Error(`Missing workflow job: ${id}`);
  return section.split(/\n {2}[\w-]+:\n/)[0];
}

function foldedCondition(section) {
  const match = section.match(/ {4}if: >-\n((?: {6}.+\n)+)/);
  if (match === null) throw new Error("Missing folded job condition");
  return match[1].trim().replaceAll(/\s+/g, " ");
}

const automation = readWorkflow("dependabot-auto-merge");
const inspect = jobSection(automation, "inspect");
const merge = jobSection(automation, "merge");

it.each(["ci", "gitleaks"])("limits %s PR triggers to main while retaining manual runs", (name) => {
  const triggers = readWorkflow(name).split("\non:\n")[1]?.split("\nconcurrency:\n")[0];

  expect(triggers).toBe("  pull_request:\n    branches: [main]\n  workflow_dispatch:\n");
});

function dependabotContext() {
  const repository = "owner/repository";
  return {
    github: {
      actor: "dependabot[bot]",
      event_name: "pull_request_target",
      repository,
      event: {
        pull_request: {
          user: { login: "dependabot[bot]" },
          base: { repo: { full_name: repository } },
          head: { repo: { full_name: repository, fork: false } },
        },
      },
    },
    needs: {
      inspect: {
        result: "success",
        outputs: { ecosystem: "npm_and_yarn", update_type: "version-update:semver-patch" },
      },
    },
  };
}

describe("required CI aggregation", () => {
  const workflow = readWorkflow("ci");
  const gate = jobSection(workflow, "ci");
  const command = gate.split("        run: |\n")[1]?.trim();

  it("keeps one unconditional CI gate and both required performance contexts", () => {
    expect(workflow.match(/^ {4}name: CI$/gm)).toHaveLength(1);
    expect(gate).toContain("needs: [quality, Performance]");
    expect(gate).toContain("if: always()");
    expect(jobSection(workflow, "Performance")).toContain("label: shared");
    expect(jobSection(workflow, "Performance")).toContain("label: refresh profiles");
    expect(command).toBeTruthy();
  });

  const results = ["success", "failure", "cancelled", "skipped", "", "unknown"];
  it.each(results.flatMap((quality) => results.map((performance) => [quality, performance])))(
    "accepts only successful quality (%s) and performance (%s)",
    (quality, performance) => {
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command],
        {
          encoding: "utf8",
          env: { ...process.env, QUALITY_RESULT: quality, PERFORMANCE_RESULT: performance },
          timeout: 5_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(quality === "success" && performance === "success" ? 0 : 1);
    },
  );
});

describe("Dependabot metadata-only auto-merge", () => {
  it("uses the target event without checking out code and grants writes only to merging", () => {
    expect(automation).toContain("  pull_request_target:");
    expect(automation).not.toContain("actions/checkout@");
    expect(automation.split("\njobs:\n")[0]).toContain("contents: read\n  pull-requests: read");
    expect(inspect).not.toContain(": write");
    expect(merge).toContain("permissions:\n      contents: write\n      pull-requests: write");
  });

  it.each(["minor", "patch"])("accepts trusted npm %s updates", (type) => {
    const context = dependabotContext();
    context.needs.inspect.outputs.update_type = `version-update:semver-${type}`;

    expect(runInNewContext(foldedCondition(inspect), context, { timeout: 100 })).toBe(true);
    expect(runInNewContext(foldedCondition(merge), context, { timeout: 100 })).toBe(true);
  });

  it.each([
    [
      "wrong event",
      (context) => {
        context.github.event_name = "pull_request";
      },
    ],
    [
      "human actor",
      (context) => {
        context.github.actor = "maintainer";
      },
    ],
    [
      "different author",
      (context) => {
        context.github.event.pull_request.user.login = "contributor";
      },
    ],
    [
      "different base",
      (context) => {
        context.github.event.pull_request.base.repo.full_name = "other/repo";
      },
    ],
    [
      "different head",
      (context) => {
        context.github.event.pull_request.head.repo.full_name = "other/repo";
      },
    ],
    [
      "fork",
      (context) => {
        context.github.event.pull_request.head.repo.fork = true;
      },
    ],
  ])("rejects %s in inspection and merging", (_name, change) => {
    const context = dependabotContext();
    change(context);

    expect(runInNewContext(foldedCondition(inspect), context, { timeout: 100 })).toBe(false);
    expect(runInNewContext(foldedCondition(merge), context, { timeout: 100 })).toBe(false);
  });

  it.each([
    ["success", "github_actions", "version-update:semver-patch"],
    ["success", "npm_and_yarn", "version-update:semver-major"],
    ["failure", "npm_and_yarn", "version-update:semver-patch"],
    ["cancelled", "npm_and_yarn", "version-update:semver-patch"],
    ["skipped", "npm_and_yarn", "version-update:semver-patch"],
    ["success", "", ""],
  ])("rejects ineligible metadata: %s / %s / %s", (result, ecosystem, updateType) => {
    const context = dependabotContext();
    context.needs.inspect = { result, outputs: { ecosystem, update_type: updateType } };

    expect(runInNewContext(foldedCondition(merge), context, { timeout: 100 })).toBe(false);
  });
});
