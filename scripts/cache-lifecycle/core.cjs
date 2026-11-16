"use strict";

const {
  cache,
  codeql,
  codeqlIdentity,
  identifier,
  object,
  policy,
  replacements,
  run,
  text,
} = require("./planner.cjs");
const { recoverReceipts } = require("./recovery.cjs");
/** @typedef {import('./types').Options} Options */
/** @typedef {import('./types').Api} Api */
/** @typedef {import('./types').Policy} Policy */
/** @typedef {import('./types').Cache} Cache */
/** @typedef {import('./types').Candidate} Candidate */

/** @param {Api} api @param {string} base */
function inventory(api, base) {
  return api.list(`${base}/actions/caches?per_page=100`, "actions_caches").map(cache);
}

/** @param {Api} api @param {string} base @param {number} self */
function activeRuns(api, base, self) {
  return ["queued", "in_progress", "waiting", "requested", "pending"]
    .flatMap((status) =>
      api.list(`${base}/actions/runs?status=${status}&per_page=100`, "workflow_runs").map(run),
    )
    .filter((r) => r.id !== self);
}

/** @param {Options} options @param {Policy} rules @param {string} base */
function context(options, rules, base) {
  const meta = object(options.api.read(base));
  if (
    meta.full_name !== rules.repository ||
    meta.default_branch !== rules.defaultBranch ||
    options.repository !== rules.repository
  )
    throw new Error("Repository/default-branch identity mismatch");
  const ref = object(
    options.api.read(`${base}/git/ref/heads/${encodeURIComponent(rules.defaultBranch)}`),
  );
  const head = text(object(ref.object).sha);
  if (options.checkoutSha !== head)
    throw new Error("Cleanup must execute the current trusted default-branch checkout");
  if (["push", "workflow_dispatch"].includes(options.eventName)) {
    producerContext(options, rules, base, head);
    return { head, producer: true };
  }
  if (options.eventName === "pull_request_target") {
    if (options.event.action !== "closed") throw new Error("Cleanup accepts only closed PR events");
    identifier(object(options.event.pull_request).number);
    return { head, producer: false };
  }
  if (options.eventName !== "workflow_run" || options.event.action !== "completed")
    throw new Error("Unsupported cleanup event");
  const eventRun = object(options.event.workflow_run);
  const triggering = run(options.api.read(`${base}/actions/runs/${identifier(eventRun.id)}`));
  if (triggering.status !== "completed") throw new Error("Triggering run is still active");
  return { head, producer: false };
}

/** @param {Options} options @param {Policy} rules @param {string} base @param {string} head */
function producerContext(options, rules, base, head) {
  const source = run(options.api.read(`${base}/actions/runs/${identifier(options.runId)}`));
  const producer = rules.producerWorkflows.find(
    (w) => w.name === source.name && w.path === source.path.split("@")[0],
  );
  if (
    options.ref !== `refs/heads/${rules.defaultBranch}` ||
    options.sha !== head ||
    !producer ||
    producer.name !== options.workflow ||
    source.head_sha !== head ||
    source.head_branch !== rules.defaultBranch ||
    source.event !== options.eventName
  ) {
    throw new Error("Untrusted producer context");
  }
  const jobs = options.api
    .list(
      `${base}/actions/runs/${options.runId}/attempts/${source.run_attempt}/jobs?per_page=100`,
      "jobs",
    )
    .map(object);
  if (
    !jobs.some(
      (job) =>
        job.name === producer.job && job.conclusion === "success" && job.status === "completed",
    )
  ) {
    throw new Error("Successful producer job has not been confirmed");
  }
}

/** @param {Api} api @param {string} base @param {number} number */
function pullRequest(api, base, number) {
  const value = object(api.read(`${base}/pulls/${identifier(number)}`));
  if (value.state !== "open" && value.state !== "closed") throw new Error("Unknown PR state");
  const head = object(value.head);
  return { state: value.state, sha: text(head.sha), branch: text(head.ref) };
}

/** @param {Cache[]} caches @param {Api} api @param {string} base @param {import('./types').Run[]} active */
function closedPullRequests(caches, api, base, active) {
  /** @type {Candidate[]} */
  const result = [];
  const numbers = new Set(
    caches.map((c) => /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(c.ref)?.[1]).filter(Boolean),
  );
  if (numbers.size > 100)
    throw new Error("Too many PR identities to verify in one bounded cleanup");
  for (const raw of numbers) {
    const number = Number(raw);
    const pr = pullRequest(api, base, number);
    const busy = active.some(
      (r) =>
        r.head_sha === pr.sha ||
        r.head_branch === pr.branch ||
        r.pull_requests?.some((q) => q.number === number),
    );
    if (pr.state !== "closed" || busy) continue;
    for (const cache of caches.filter((c) =>
      [`refs/pull/${number}/merge`, `refs/pull/${number}/head`].includes(c.ref),
    )) {
      result.push({ cache, reason: "closed PR without active runs" });
    }
  }
  return result;
}

/** @param {Cache[]} caches @param {Options} options @param {string} head @param {string} base */
function codeqlProofs(caches, options, head, base) {
  const ids = new Set(
    caches
      .filter((c) => c.ref === `refs/heads/${options.policy.defaultBranch}` && c.size_in_bytes > 0)
      .map(codeqlIdentity)
      .filter((c) => c?.sha === head)
      .map((c) => c?.runId),
  );
  if (ids.size > 25) throw new Error("Too many CodeQL proofs");
  return [...ids].map((id) => run(options.api.read(`${base}/actions/runs/${identifier(id)}`)));
}

/** @param {Candidate} candidate @param {Cache[]} fresh @param {Options} options @param {string} base @param {import('./types').Run[]} running */
function stillValid(candidate, fresh, options, base, running) {
  const current = fresh.find((c) => c.id === candidate.cache.id);
  if (
    !current ||
    current.key !== candidate.cache.key ||
    current.ref !== candidate.cache.ref ||
    current.version !== candidate.cache.version ||
    current.last_accessed_at !== candidate.cache.last_accessed_at
  )
    return false;
  if (candidate.replacement) {
    const replacement = fresh.find((c) => c.id === candidate.replacement?.id);
    return Boolean(
      replacement &&
      replacement.key === candidate.replacement.key &&
      replacement.version === candidate.replacement.version &&
      replacement.size_in_bytes > 0,
    );
  }
  const number = Number(/^refs\/pull\/(\d+)\//.exec(current.ref)?.[1]);
  const pr = pullRequest(options.api, base, number);
  return (
    pr.state === "closed" &&
    !running.some(
      (r) =>
        r.head_sha === pr.sha ||
        r.head_branch === pr.branch ||
        r.pull_requests?.some((q) => q.number === number),
    )
  );
}

/** @param {Options} options */
function runLifecycle(options) {
  const rules = policy(options.policy);
  const base = `repos/${rules.repository}`;
  const { head, producer } = context(options, rules, base);
  const caches = inventory(options.api, base);
  const active = activeRuns(options.api, base, options.runId);
  let candidates = closedPullRequests(caches, options.api, base, active);
  const receipts = producer
    ? options.replacements
    : options.eventName === "workflow_run"
      ? recoverReceipts(options, rules, base, head)
      : [];
  candidates.push(...replacements(caches, receipts, rules));
  candidates.push(...codeql(caches, codeqlProofs(caches, options, head, base), rules, head));
  const unique = [...new Map(candidates.map((c) => [c.cache.id, c])).values()];
  if (unique.length > 100) throw new Error("Cleanup deletion budget exceeded; no caches deleted");
  const fresh = inventory(options.api, base);
  const latest = object(
    options.api.read(`${base}/git/ref/heads/${encodeURIComponent(rules.defaultBranch)}`),
  );
  if (object(latest.object).sha !== head)
    throw new Error("Default branch changed during planning; no caches deleted");
  const running = activeRuns(options.api, base, options.runId);
  const eligible = unique.filter(
    (c) => (!c.replacement || !running.length) && stillValid(c, fresh, options, base, running),
  );
  const deleted = [];
  for (const candidate of eligible) {
    if (!options.dryRun) options.api.remove(candidate.cache.id);
    deleted.push({
      id: candidate.cache.id,
      bytes: candidate.cache.size_in_bytes,
      reason: candidate.reason,
    });
  }
  const remaining = inventory(options.api, base);
  if (!options.dryRun && deleted.some((c) => remaining.some((r) => r.id === c.id)))
    throw new Error("Cache deletion readback failed");
  return {
    dryRun: Boolean(options.dryRun),
    deleted,
    deferred: unique.length - eligible.length,
    activeRuns: running.length,
    remainingCount: remaining.length,
    remainingBytes: remaining.reduce((sum, c) => sum + c.size_in_bytes, 0),
  };
}

module.exports = { runLifecycle };
