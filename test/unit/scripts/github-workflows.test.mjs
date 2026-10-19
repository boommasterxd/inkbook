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
    expect(gate).toContain("needs: [select, quality, Performance]");
    expect(gate).toContain("if: always()");
    expect(jobSection(workflow, "Performance")).toContain("label: shared");
    expect(jobSection(workflow, "Performance")).toContain("label: refresh profiles");
    expect(command).toBeTruthy();
  });

  function runGate(overrides = {}) {
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SELECT_RESULT: "success",
          QUALITY_RESULT: "success",
          PERFORMANCE_RESULT: "success",
          MODE: "full",
          SHARED: "true",
          CADENCE: "true",
          BUILD: "true",
          ...overrides,
        },
        timeout: 5_000,
      },
    );
    expect(result.error).toBeUndefined();
    return result.status;
  }

  const results = ["failure", "cancelled", "skipped", "", "unknown"];
  it.each(
    ["SELECT_RESULT", "QUALITY_RESULT", "PERFORMANCE_RESULT"].flatMap((job) =>
      results.map((result) => [job, result]),
    ),
  )("rejects %s with result %s", (job, result) => {
    expect(runGate({ [job]: result })).toBe(1);
  });

  it.each([
    ["full", "true", "true", "true"],
    ["full", "true", "true", "false"],
    ["docs", "false", "false", "false"],
    ...["true", "false"].flatMap((shared) =>
      ["true", "false"].flatMap((cadence) =>
        ["true", "false"].map((build) => ["affected", shared, cadence, build]),
      ),
    ),
  ])("accepts a validated %s plan (%s/%s/%s)", (mode, shared, cadence, build) => {
    expect(runGate({ MODE: mode, SHARED: shared, CADENCE: cadence, BUILD: build })).toBe(0);
  });

  it.each([
    { MODE: "" },
    { MODE: "unknown" },
    { SHARED: "false" },
    { CADENCE: "false" },
    ...["SHARED", "CADENCE", "BUILD"].flatMap((field) => [
      { MODE: "docs", SHARED: "false", CADENCE: "false", BUILD: "false", [field]: "true" },
      { MODE: "affected", [field]: "" },
      { MODE: "affected", [field]: "unknown" },
    ]),
  ])("rejects missing or inconsistent selection outputs: %j", (outputs) => {
    expect(runGate(outputs)).toBe(1);
  });
});

describe("affected CI selection", () => {
  const workflow = readWorkflow("ci");

  it("checks the current merge result with complete history while comparing the PR head", () => {
    expect(workflow).toContain("CI_BASE: ${{ github.event.pull_request.base.sha }}");
    expect(workflow).toContain("CI_EVENT: ${{ github.event_name }}");
    const head = "${{ github.event.pull_request.head.sha || github.sha }}";
    expect(workflow).toContain(`CI_HEAD: ${head}`);
    for (const id of ["select", "quality", "Performance"]) {
      const section = jobSection(workflow, id);
      expect(section).toContain("ref: ${{ github.sha }}\n          fetch-depth: 0");
      expect(section).toContain('node-version: "24.x"\n          check-latest: true');
      expect(section).toContain("cache: npm");
      expect(section).toContain("run: npm ci");
      expect(section).toContain("run: node scripts/ci-plan.mjs");
    }
  });

  it("revalidates the detector outputs in each active consumer", () => {
    for (const id of ["quality", "Performance"]) {
      const section = jobSection(workflow, id);
      expect(section).toContain("needs: select");
      for (const field of ["mode", "shared", "cadence", "build"]) {
        expect(section).toContain(
          `EXPECTED_${field.toUpperCase()}: \${{ needs.select.outputs.${field} }}`,
        );
      }
    }
    expect(jobSection(workflow, "quality")).toContain("run: node scripts/run-ci.mjs quality");
    expect(jobSection(workflow, "Performance")).toContain(
      'run: node scripts/run-ci.mjs "${INKBOOK_PERFORMANCE_SUITE}"',
    );
  });

  it("skips dependency installation only after documentation preflight", () => {
    const selection = jobSection(workflow, "select");
    expect(selection).toContain("id: preflight\n        run: node scripts/ci-plan.mjs --preflight");
    expect(selection.match(/if: steps.preflight.outputs.docs != 'true'/g)).toHaveLength(1);
    expect(selection.indexOf("- name: Set up Node.js")).toBeLessThan(
      selection.indexOf("- name: Detect documentation-only changes"),
    );
    expect(selection).not.toContain(
      "- name: Set up Node.js\n        if: steps.preflight.outputs.docs",
    );
    expect(selection).toContain("id: plan\n        run: node scripts/ci-plan.mjs");
    const quality = jobSection(workflow, "quality");
    expect(quality.match(/if: needs.select.outputs.mode != 'docs'/g)).toHaveLength(5);
    expect(quality).toContain("if: needs.select.outputs.mode == 'docs'");
  });

  it("runs both required matrix contexts and skips only deliberate empty selections", () => {
    const performance = jobSection(workflow, "Performance");
    expect(performance).toContain("fail-fast: true");
    expect(performance).not.toMatch(/^ {4}if:/m);
    expect(performance.match(/if: needs.select.outputs\[matrix.suite\] == 'true'/g)).toHaveLength(
      5,
    );
    expect(performance).toContain("if: needs.select.outputs[matrix.suite] == 'false'");
    for (const selected of ["true", "false", "", "unknown"]) {
      const context = {
        needs: { select: { outputs: { shared: selected } } },
        matrix: { suite: "shared" },
      };
      expect(runInNewContext("needs.select.outputs[matrix.suite] == 'true'", context)).toBe(
        selected === "true",
      );
      expect(runInNewContext("needs.select.outputs[matrix.suite] == 'false'", context)).toBe(
        selected === "false",
      );
    }
  });
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
