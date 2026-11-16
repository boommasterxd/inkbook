"use strict";

const { identifier, object, replacements, run, text } = require("./planner.cjs");
/** @typedef {import('./types').Policy} Policy */
/** @typedef {import('./types').Replacement} Replacement */
/** @typedef {import('./types').Options & {api: import('./types').Api & {readReceipts(runId:number, attempt:number):unknown}}} RecoveryOptions */

/** @param {unknown} value @param {Policy} rules @returns {Replacement[]} */
function receipts(value, rules) {
  if (!Array.isArray(value) || value.length > 20)
    throw new Error("Invalid or oversized replacement receipts");
  const result = value.map((raw) => {
    const item = object(raw);
    return { family: text(item.family), key: text(item.key), prefix: text(item.prefix) };
  });
  // Reuse the normal family, compatibility and duplicate validation before recovery.
  replacements([], result, rules);
  return result;
}

/** @param {RecoveryOptions} options @param {Policy} rules @param {string} base @param {string} head @param {boolean} exact */
function producerRuns(options, rules, base, head, exact) {
  const page = object(
    options.api.read(
      `${base}/actions/runs?${exact ? `head_sha=${head}&` : ""}branch=${rules.defaultBranch}&status=success&per_page=20`,
    ),
  );
  const rows = page.workflow_runs;
  if (!Array.isArray(rows) || rows.length > 20) throw new Error("Invalid producer recovery page");
  const runs = rows
    .map(run)
    .filter(
      (run) =>
        run.status === "completed" &&
        run.conclusion === "success" &&
        (!exact || run.head_sha === head) &&
        run.head_branch === rules.defaultBranch &&
        ["push", "workflow_dispatch"].includes(run.event) &&
        rules.producerWorkflows.some(
          (w) => w.name === run.name && w.path === run.path.split("@")[0],
        ),
    );
  return runs.sort((a, b) => b.id - a.id);
}

/** @param {RecoveryOptions} options @param {Policy} rules @param {string} base @param {string} source @param {string} head */
function unchangedInputs(options, rules, base, source, head) {
  if (source === head) return true;
  const comparison = object(options.api.read(`${base}/compare/${source}...${head}?per_page=100`));
  const total = comparison.total_commits;
  if (
    !Number.isSafeInteger(total) ||
    Number(total) < 1 ||
    Number(total) > 100 ||
    comparison.ahead_by !== total ||
    comparison.status !== "ahead" ||
    !Array.isArray(comparison.commits) ||
    comparison.commits.length !== total ||
    !Array.isArray(comparison.files) ||
    comparison.files.length >= 300
  )
    return false;
  if (
    object(comparison.base_commit).sha !== source ||
    object(comparison.merge_base_commit).sha !== source ||
    object(comparison.commits.at(-1)).sha !== head
  )
    return false;
  return comparison.files.every((raw) => {
    const file = object(raw);
    const paths = [text(file.filename)];
    if (file.previous_filename !== undefined) paths.push(text(file.previous_filename));
    return paths.every(
      (filename) =>
        !rules.producerInputs.some((input) =>
          input.endsWith("/") ? filename.startsWith(input) : filename === input,
        ),
    );
  });
}

/** @param {RecoveryOptions} options @param {Policy} rules @param {string} base @param {string} head @returns {Replacement[]} */
function recoverReceipts(options, rules, base, head) {
  const latest =
    producerRuns(options, rules, base, head, true)[0] ||
    producerRuns(options, rules, base, head, false)[0];
  if (!latest) return [];
  if (!unchangedInputs(options, rules, base, latest.head_sha, head)) return [];
  const attempt = identifier(object(latest).run_attempt);
  const producer = rules.producerWorkflows.find(
    (w) => w.name === latest.name && w.path === latest.path.split("@")[0],
  );
  const jobs = options.api
    .list(`${base}/actions/runs/${latest.id}/attempts/${attempt}/jobs?per_page=100`, "jobs")
    .map(object);
  if (
    !jobs.some(
      (job) =>
        job.name === producer?.job && job.status === "completed" && job.conclusion === "success",
    )
  ) {
    throw new Error("Recovered producer attempt has no successful warmup job");
  }
  return receipts(options.api.readReceipts(latest.id, attempt), rules);
}

module.exports = { recoverReceipts };
