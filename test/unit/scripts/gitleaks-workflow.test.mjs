import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

let workflow;
let scanScript;
let directory;
let repository;
let runnerTemp;
let environment;
const marker = ["synthetic", "history", "finding"].join("-");

function execute(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repository,
    encoding: "utf8",
    timeout: 10_000,
    env: environment,
    ...options,
  });
}

function git(...args) {
  const result = execute("git", args);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function commit(content) {
  await writeFile(join(repository, "credentials.txt"), content);
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture");
  return git("rev-parse", "HEAD");
}

function scan(event, base = "", head = "") {
  return execute("bash", ["--noprofile", "--norc", "-c", scanScript], {
    env: { ...environment, GITHUB_EVENT_NAME: event, PR_BASE_SHA: base, PR_HEAD_SHA: head },
  });
}

beforeAll(async () => {
  workflow = await readFile(
    new URL("../../../.github/workflows/gitleaks.yml", import.meta.url),
    "utf8",
  );
  scanScript = workflow
    .split("        run: |\n")[1]
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "inkbook-gitleaks-"));
  repository = join(directory, "repository");
  runnerTemp = join(directory, "runner");
  const commands = join(directory, "commands");
  await Promise.all([repository, runnerTemp, commands].map((path) => mkdir(path)));
  environment = {
    ...process.env,
    PATH: `${commands}:${process.env["PATH"]}`,
    RUNNER_TEMP: runnerTemp,
    SCAN_CALLS: join(directory, "calls"),
    SCAN_MARKER: marker,
    SCAN_ARCHIVE: join(directory, "scanner.tar.gz"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  git("init", "--quiet");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  await prepareScanner(commands);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function prepareScanner(commands) {
  // Replace only download/detection boundaries; execute the unchanged workflow shell,
  // checksum verification, archive extraction, commit validation and real Git ranges.
  const scanner = join(directory, "gitleaks");
  await writeFile(
    scanner,
    `#!/usr/bin/env bash
set -euo pipefail
mode="$1"
shift
printf '%s\\n' "$mode" >> "$SCAN_CALLS"
[[ " $* " == *" --config .gitleaks.toml "* ]]
[[ " $* " == *" --redact "* ]]
[[ " $* " == *" --exit-code 1 "* ]]
if [[ "$mode" == dir ]]; then
  if grep -q "$SCAN_MARKER" credentials.txt; then exit 1; fi
elif [[ "$mode" == git ]]; then
  for argument in "$@"; do
    if [[ "$argument" == --log-opts=* ]]; then range="\${argument#--log-opts=}"; fi
  done
  git log --format= --patch "$range" -- > "$RUNNER_TEMP/history"
  if grep -q "$SCAN_MARKER" "$RUNNER_TEMP/history"; then exit 1; fi
else
  exit 2
fi
`,
  );
  await chmod(scanner, 0o755);
  const archive = environment["SCAN_ARCHIVE"];
  expect(execute("tar", ["-czf", archive, "-C", directory, "gitleaks"]).status).toBe(0);
  const checksum = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(
    join(repository, ".gitleaks-version"),
    JSON.stringify({ version: "fixture", sha256: checksum }),
  );
  await writeFile(join(repository, ".gitleaks.toml"), "[extend]\nuseDefault = true\n");
  const download = join(commands, "curl");
  await writeFile(
    download,
    '#!/usr/bin/env bash\ncp "$SCAN_ARCHIVE" "$RUNNER_TEMP/gitleaks.tar.gz"\n',
  );
  await chmod(download, 0o755);
}

describe("gitleaks workflow execution", () => {
  it("fetches complete history while preserving the merge checkout and read-only credentials", () => {
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("ref:");
  });

  it("rejects a secret introduced and removed between the PR base and head", async () => {
    const base = await commit("clean base");
    await commit(marker);
    const head = await commit("clean head");
    expect(scan("pull_request", base, head).status).toBe(1);
    expect(await readFile(environment["SCAN_CALLS"], "utf8")).toBe("dir\ngit\n");
  });

  it("excludes base history for PRs and includes it for manual runs", async () => {
    await commit(marker);
    const base = await commit("clean base");
    const head = await commit("clean head");
    expect(scan("pull_request", base, head).status).toBe(0);
    expect(scan("workflow_dispatch").status).toBe(1);
  });

  it("retains the checked-out tree scan for uncommitted findings", async () => {
    const base = await commit("clean base");
    const head = await commit("clean head");
    await writeFile(join(repository, "credentials.txt"), marker);
    expect(scan("pull_request", base, head).status).toBe(1);
    expect(await readFile(environment["SCAN_CALLS"], "utf8")).toBe("dir\n");
  });

  it("rejects unsupported events, missing, malformed and unavailable PR commits", async () => {
    const head = await commit("clean");
    for (const args of [
      ["push", head, head],
      ["pull_request", "", head],
      ["pull_request", head, "--all"],
      ["pull_request", "0".repeat(40), head],
    ]) {
      expect(scan(...args).status).not.toBe(0);
    }
    await expect(readFile(environment["SCAN_CALLS"], "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed on shallow history and a checksum mismatch", async () => {
    const head = await commit("clean");
    await writeFile(join(repository, ".git", "shallow"), `${head}\n`);
    expect(scan("workflow_dispatch").status).toBe(1);
    await rm(join(repository, ".git", "shallow"));
    await writeFile(
      join(repository, ".gitleaks-version"),
      JSON.stringify({ version: "fixture", sha256: "0".repeat(64) }),
    );
    expect(scan("workflow_dispatch").status).not.toBe(0);
    await expect(readFile(environment["SCAN_CALLS"], "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
