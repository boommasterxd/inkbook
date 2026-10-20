import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

let workflow;
let scripts;
let scriptPaths;
let directory;
let environment;
const current = { version: "8.30.1", sha256: "a".repeat(64) };
const branch = "dependencies/update-gitleaks-8.30.2";

beforeAll(async () => {
  workflow = await fs.readFile(
    new URL("../../../.github/workflows/update-gitleaks.yml", import.meta.url),
    "utf8",
  );
  scripts = workflow
    .split("        run: |\n")
    .slice(1)
    .map((block) =>
      block
        .split("\n      - name:")[0]
        .split("\n")
        .map((line) => line.replace(/^ {10}/, ""))
        .join("\n"),
    );
});

async function prepareFixture() {
  directory = await fs.mkdtemp(join(tmpdir(), "inkbook-gitleaks-updater-"));
  const commands = join(directory, "commands");
  const runnerTemp = join(directory, "runner");
  await Promise.all([commands, runnerTemp].map((path) => fs.mkdir(path)));
  // Execute trusted repository workflow code as script files, never command strings.
  scriptPaths = scripts.map((_script, index) => join(directory, `workflow-${index}.sh`));
  await Promise.all(
    scripts.map((script, index) =>
      fs.writeFile(scriptPaths[index], script, { flag: "wx", mode: 0o600 }),
    ),
  );
  environment = {
    ...process.env,
    PATH: `${commands}:${process.env["PATH"]}`,
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: join(directory, "output"),
    GITHUB_REPOSITORY: "fixture/repository",
    FIXTURE_CALLS: join(directory, "calls"),
  };
  await fs.writeFile(join(directory, ".gitleaks-version"), JSON.stringify(current));
  await fs.writeFile(environment["GITHUB_OUTPUT"], "");
  await fs.writeFile(environment["FIXTURE_CALLS"], "");
  for (const command of ["gh", "git", "curl"]) {
    const path = join(commands, command);
    await fs.writeFile(path, `#!${process.execPath}\n${providerBoundary}`);
    await fs.chmod(path, 0o755);
  }
}

// The workflow's shell, jq transformations and file writes run unchanged. Provider
// commands only record requests and return isolated responses; nothing is published.
const providerBoundary = `
const {appendFileSync, writeFileSync} = require("node:fs");
const {basename} = require("node:path");
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const fixture = JSON.parse(process.env.FIXTURE_SCENARIO);
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify([command, ...args]) + "\\n");
if (command === "gh" && args[0] === "api") {
  if (fixture.releaseFailure) process.exit(1);
  console.log(fixture.tag ?? "v8.30.2");
} else if (command === "gh" && args[0] === "pr" && args[1] === "list") {
  if (fixture.lookupFailure) process.exit(1);
  console.log(fixture.openPrs ?? "0");
} else if (command === "gh" && args[0] === "pr" && args[1] === "create") {
  process.exit(0);
} else if (command === "git" && args[0] === "ls-remote") {
  process.exit(fixture.branchStatus ?? 2);
} else if (command === "git" && ["config", "switch", "add", "commit", "push"].includes(args[0])) {
  process.exit(0);
} else if (command === "curl") {
  writeFileSync(args[args.indexOf("--output") + 1],
    fixture.checksums ?? "b".repeat(64) + "  gitleaks_8.30.2_linux_x64.tar.gz\\n");
} else {
  process.exit(99);
}
`;

function execute(scriptPath, scenario = {}, extra = {}) {
  return spawnSync("bash", ["--noprofile", "--norc", scriptPath], {
    cwd: directory,
    env: { ...environment, FIXTURE_SCENARIO: JSON.stringify(scenario), ...extra },
    encoding: "utf8",
    timeout: 10_000,
  });
}

async function calls() {
  return (await fs.readFile(environment["FIXTURE_CALLS"], "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function expectUnchanged(result, status = 0) {
  expect(result.status, result.stderr).toBe(status);
  expect(JSON.parse(await fs.readFile(join(directory, ".gitleaks-version"), "utf8"))).toEqual(
    current,
  );
  const requests = await calls();
  expect(requests).not.toContainEqual(expect.arrayContaining(["curl"]));
  expect(requests).not.toContainEqual(expect.arrayContaining(["push"]));
  expect(requests).not.toContainEqual(expect.arrayContaining(["create"]));
}

it("serializes monthly and manual updates without interrupting publication", () => {
  expect(workflow).toContain('cron: "0 6 1 * *"');
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("group: update-gitleaks\n  cancel-in-progress: false");
  expect(workflow).toContain("timeout-minutes: 10");
  expect(workflow).not.toContain("--auto");
});

describe("gitleaks updater workflow execution", () => {
  beforeEach(prepareFixture);
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each([
    ["unchanged version", { tag: "v8.30.1" }],
    ["existing branch", { branchStatus: 0 }],
    ["existing open pull request", { openPrs: "1" }],
  ])("leaves the manifest unchanged for %s", async (_name, scenario) => {
    await expectUnchanged(execute(scriptPaths[0], scenario));
    expect(await fs.readFile(environment["GITHUB_OUTPUT"], "utf8")).toBe("changed=false\n");
  });

  it("updates the checksum and opens one normal PR only when the branch and PR are absent", async () => {
    const result = execute(scriptPaths[0]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await fs.readFile(join(directory, ".gitleaks-version"), "utf8"))).toEqual({
      version: "8.30.2",
      sha256: "b".repeat(64),
    });
    expect(await fs.readFile(environment["GITHUB_OUTPUT"], "utf8")).toBe(
      "changed=true\nversion=8.30.2\n",
    );
    const publication = execute(scriptPaths[1], {}, { VERSION: "8.30.2" });
    expect(publication.status, publication.stderr).toBe(0);
    const requests = await calls();
    expect(requests.find((request) => request[0] === "git")).toEqual([
      "git",
      "ls-remote",
      "--exit-code",
      "--heads",
      "origin",
      `refs/heads/${branch}`,
    ]);
    expect(requests).toContainEqual(["git", "push", "--set-upstream", "origin", branch]);
    const lookup = requests.find((request) => request[0] === "gh" && request[2] === "list");
    expect(lookup).toEqual([
      "gh",
      "pr",
      "list",
      "--repo",
      "fixture/repository",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number",
      "--jq",
      "length",
    ]);
    const creations = requests.filter((request) => request[0] === "gh" && request[2] === "create");
    expect(creations).toHaveLength(1);
    expect(creations[0]).toEqual(
      expect.arrayContaining(["--repo", "fixture/repository", "--base", "main", "--head", branch]),
    );
  });

  it.each([
    ["release lookup failure", { releaseFailure: true }, 1],
    ["PR lookup failure", { lookupFailure: true }, 1],
    ["malformed PR lookup", { openPrs: "unknown" }, 1],
    ["remote Git failure", { branchStatus: 128 }, 128],
    ["invalid release tag", { tag: "v8.30.2-rc.1" }, 1],
  ])("fails closed for %s", async (_name, scenario, status) => {
    await expectUnchanged(execute(scriptPaths[0], scenario), status);
    expect(await fs.readFile(environment["GITHUB_OUTPUT"], "utf8")).toBe("");
  });

  it.each([
    ["missing archive", `${"b".repeat(64)}  other.tar.gz\n`],
    ["invalid digest", "invalid  gitleaks_8.30.2_linux_x64.tar.gz\n"],
    ["duplicate digests", `${`${"b".repeat(64)}  gitleaks_8.30.2_linux_x64.tar.gz\n`.repeat(2)}`],
  ])("rejects %s without changing the pinned manifest", async (_name, checksums) => {
    expect(execute(scriptPaths[0], { checksums }).status).toBe(1);
    expect(JSON.parse(await fs.readFile(join(directory, ".gitleaks-version"), "utf8"))).toEqual(
      current,
    );
    expect(await fs.readFile(environment["GITHUB_OUTPUT"], "utf8")).toBe("");
  });
});
