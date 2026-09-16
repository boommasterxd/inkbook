import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  boundedItems,
  git,
  githubApi,
  publishBaseline,
  readBaselineArtifact,
  remoteBaseline,
} from "./performance-baseline-github.mjs";
import {
  requireBaseline,
  validateBaselineReports,
  validateJobs,
  validateWorkflowRun,
} from "./performance-baseline-validation.mjs";

const WORKFLOWS = [
  ["ci.yml", ["CI", "Performance (shared)", "Performance (refresh profiles)"]],
  ["gitleaks.yml", ["gitleaks"]],
  ["commit-style-check.yml", ["Validate PR Title"]],
];

function successfulRun(repository, pr, workflow) {
  const response = githubApi(
    `repos/${repository}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`,
  );
  const runs = boundedItems(response, "workflow_runs");
  const matching = runs.filter(
    (run) =>
      Array.isArray(run.pull_requests) &&
      (run.pull_requests.length === 0 ||
        run.pull_requests.some((item) => item.number === pr.number)),
  );
  requireBaseline(matching.length > 0, `Missing PR run: ${workflow}`);
  const run = matching.sort((left, right) => right.id - left.id)[0];
  validateWorkflowRun(run, { repository, number: pr.number, head: pr.head.sha, workflow });
  return run;
}

function verifiedRuns(repository, pr) {
  const runs = [];
  for (const [workflow, names] of WORKFLOWS) {
    const run = successfulRun(repository, pr, workflow);
    const response = githubApi(
      `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
    );
    validateJobs(boundedItems(response, "jobs"), names);
    runs.push(run);
  }
  return runs;
}

function baselineReports(repository, run) {
  const response = githubApi(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`);
  const artifacts = boundedItems(response, "artifacts");
  return ["shared", "cadence"].map((suite) => {
    const matches = artifacts.filter(
      (artifact) => artifact.name === `performance-baseline-${suite}`,
    );
    requireBaseline(matches.length === 1, `Missing or ambiguous ${suite} report`);
    return readBaselineArtifact(repository, matches[0]);
  });
}

function mergedPullRequest(repository, merge) {
  const pulls = githubApi(`repos/${repository}/commits/${merge}/pulls?per_page=100`);
  requireBaseline(pulls.length < 100, "Too many associated pull requests");
  const matches = pulls.filter(
    (pr) =>
      pr.merged_at &&
      pr.merge_commit_sha === merge &&
      pr.base.ref === "main" &&
      pr.base.repo.full_name === repository,
  );
  requireBaseline(matches.length === 1, "Exactly one merged main PR is required");
  return githubApi(`repos/${repository}/pulls/${matches[0].number}`);
}

export function promoteBaseline(environment = process.env) {
  const repository = environment.GITHUB_REPOSITORY;
  const merge = environment.GITHUB_SHA;
  requireBaseline(
    /^[\w.-]+\/[\w.-]+$/.test(repository) && /^[a-f0-9]{40}$/.test(merge),
    "Invalid promotion context",
  );
  requireBaseline(
    environment.GITHUB_EVENT_NAME === "push" && environment.GITHUB_REF === "refs/heads/main",
    "Only main pushes may promote",
  );
  requireBaseline(git(["rev-parse", "HEAD"]) === merge, "Checkout is not the merged commit");
  const pr = mergedPullRequest(repository, merge);
  const [run] = verifiedRuns(repository, pr);
  const reports = baselineReports(repository, run);
  if (
    reports.some((report) => report.eligible === false) ||
    reports.every((report) => report.improvedMetrics === 0)
  ) {
    process.stdout.write("Performance baseline unchanged: no complete strict improvement proof\n");
    return;
  }
  const previous = remoteBaseline();
  const anchor =
    previous ?? JSON.parse(readFileSync(".github/performance-policy.json", "utf8")).anchorCommit;
  requireBaseline(
    reports[0].testedCommit && /^[a-f0-9]{40}$/.test(reports[0].testedCommit),
    "Invalid tested commit",
  );
  const tested = githubApi(`repos/${repository}/git/commits/${reports[0].testedCommit}`);
  const merged = githubApi(`repos/${repository}/git/commits/${merge}`);
  requireBaseline(merged.parents.length === 1, "Only squash merges are eligible");
  const base = merged.parents[0].sha;
  requireBaseline(
    tested.parents.length === 2 &&
      tested.parents[0].sha === base &&
      tested.parents[1].sha === pr.head.sha,
    "Tested commit is not the matching PR merge",
  );
  requireBaseline(tested.tree.sha === merged.tree.sha, "Tested and merged trees differ");
  const context = {
    testedCommit: tested.sha,
    testedTree: merged.tree.sha,
    anchorCommit: anchor,
    baseCommit: base,
    runId: String(run.id),
    runAttempt: String(run.run_attempt),
  };
  const summary = validateBaselineReports(reports, context);
  git(["merge-base", "--is-ancestor", anchor, merge]);
  publishBaseline(
    { merge, previous, anchor, run },
    {
      ...summary,
      improvements: reports.flatMap((report) =>
        report.metrics.map(({ key, ratios, status }) => ({
          suite: report.suite,
          key,
          ratios,
          status,
        })),
      ),
    },
  );
  process.stdout.write(`Performance baseline advanced from ${anchor} to ${merge}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    promoteBaseline();
  } catch (error) {
    console.error(`Performance baseline unchanged: ${error.message}`);
    process.exitCode = 1;
  }
}
