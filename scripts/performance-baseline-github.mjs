import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requireBaseline } from "./performance-baseline-validation.mjs";

const MAX_REPORT_BYTES = 2_000_000;

export function githubApi(path) {
  const value = execFileSync("gh", ["api", path], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4_000_000,
  });
  return JSON.parse(value);
}

export function boundedItems(response, key) {
  requireBaseline(
    response.total_count <= 100 && Array.isArray(response[key]),
    `Too many or invalid ${key}`,
  );
  return response[key];
}

export function readBaselineArtifact(repository, artifact) {
  requireBaseline(
    !artifact.expired && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= MAX_REPORT_BYTES,
    "Expired or oversized baseline artifact",
  );
  const directory = mkdtempSync(join(tmpdir(), "inkbook-baseline-"));
  try {
    const zip = execFileSync(
      "gh",
      ["api", `repos/${repository}/actions/artifacts/${artifact.id}/zip`],
      { timeout: 30_000, maxBuffer: MAX_REPORT_BYTES },
    );
    const path = join(directory, "report.zip");
    writeFileSync(path, zip);
    const listing = execFileSync("unzip", ["-Z1", path], {
      encoding: "utf8",
      maxBuffer: 4096,
    }).trim();
    requireBaseline(listing === "baseline-report.json", "Unexpected baseline artifact entries");
    const value = execFileSync("unzip", ["-p", path, "baseline-report.json"], {
      encoding: "utf8",
      maxBuffer: MAX_REPORT_BYTES,
      timeout: 5000,
    });
    return JSON.parse(value);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4_000_000,
    ...options,
  }).trim();
}

export function remoteBaseline() {
  const result = git(["ls-remote", "--refs", "origin", "refs/tags/performance-baseline"]);
  const sha = result ? result.split(/\s+/)[0] : null;
  requireBaseline(sha === null || /^[a-f0-9]{40}$/.test(sha), "Invalid baseline reference");
  return sha;
}

export function publishBaseline(context, summary) {
  const tag = `performance-baseline-audit-${context.merge}`;
  const ref = "refs/tags/performance-baseline";
  const audit = {
    version: 1,
    previous: context.anchor,
    next: context.merge,
    runId: context.run.id,
    runAttempt: context.run.run_attempt,
    runUrl: context.run.html_url,
    ...summary,
  };
  git(
    [
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "tag",
      "-a",
      tag,
      context.merge,
      "-F",
      "-",
    ],
    { input: `${JSON.stringify(audit)}\n` },
  );
  git([
    "push",
    "--atomic",
    `--force-with-lease=${ref}:${context.previous ?? ""}`,
    "origin",
    `${context.merge}:${ref}`,
    `refs/tags/${tag}:refs/tags/${tag}`,
  ]);
}
