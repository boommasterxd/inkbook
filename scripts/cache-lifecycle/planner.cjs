"use strict";

/** @typedef {import('./types').Cache} Cache */
/** @typedef {import('./types').Policy} Policy */
/** @typedef {import('./types').Replacement} Replacement */
/** @typedef {import('./types').Run} Run */
/** @typedef {import('./types').Candidate} Candidate */

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @returns {string} */
function text(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\r\n\0]/.test(value)) {
    throw new Error("Expected a bounded nonempty string");
  }
  return value;
}

/** @param {unknown} value @returns {number} */
function identifier(value) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error("Invalid GitHub identifier");
  return Number(value);
}

/** @param {unknown} value */
function producerInputs(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100) {
    throw new Error("Missing bounded producer inputs");
  }
  for (const input of value) {
    if (
      !/^[\w.-][\w./-]*$/.test(text(input)) ||
      text(input)
        .split("/")
        .some((part) => part === ".." || part === ".")
    ) {
      throw new Error("Invalid producer input path");
    }
  }
}

/** @param {unknown} value @returns {Policy} */
function policy(value) {
  const p = object(value);
  if (p.schemaVersion !== 1 || !/^[\w.-]+\/[\w.-]+$/.test(text(p.repository)))
    throw new Error("Invalid lifecycle policy");
  if (!/^[\w./-]+$/.test(text(p.defaultBranch))) throw new Error("Invalid default branch");
  producerInputs(p.producerInputs);
  for (const field of ["producerWorkflows", "codeqlWorkflows"]) {
    if (!Array.isArray(p[field])) throw new Error("Missing workflow allowlist");
    for (const raw of p[field]) {
      const w = object(raw);
      text(w.name);
      if (field === "producerWorkflows") text(w.job);
      if (
        !/^(?:\.github\/workflows\/[\w.-]+\.ya?ml|dynamic\/github-code-scanning\/codeql)$/.test(
          text(w.path),
        )
      ) {
        throw new Error("Invalid trusted workflow path");
      }
    }
  }
  const families = object(p.families);
  for (const [name, prefix] of Object.entries(families)) {
    if (!/^[\w-]+$/.test(name) || !/^[\w.-]{4,}-$/.test(text(prefix)))
      throw new Error("Unbounded cache family");
  }
  if (!Array.isArray(p.retiredPrefixes)) throw new Error("Missing retired-prefix policy");
  for (const raw of p.retiredPrefixes) {
    const retired = object(raw);
    if (!/^[\w.-]{8,}-$/.test(text(retired.prefix)) || !families[text(retired.replacement)]) {
      throw new Error("Invalid retired namespace mapping");
    }
  }
  return /** @type {Policy} */ (/** @type {unknown} */ (p));
}

/** @param {unknown} value @returns {Cache} */
function cache(value) {
  const c = object(value);
  identifier(c.id);
  for (const field of ["key", "ref", "version"]) text(c[field]);
  for (const field of ["created_at", "last_accessed_at"]) {
    if (!Number.isFinite(Date.parse(text(c[field])))) throw new Error("Invalid cache timestamp");
  }
  if (!Number.isSafeInteger(c.size_in_bytes) || Number(c.size_in_bytes) < 0)
    throw new Error("Invalid cache size");
  return /** @type {Cache} */ (/** @type {unknown} */ (c));
}

/** @param {unknown} value @returns {Run} */
function run(value) {
  const r = object(value);
  identifier(r.id);
  identifier(r.run_attempt);
  for (const field of ["name", "path", "head_branch", "event", "status"]) text(r[field]);
  if (!/^[a-f0-9]{40}$/.test(text(r.head_sha))) throw new Error("Invalid workflow revision");
  if (r.conclusion !== null) text(r.conclusion);
  return /** @type {Run} */ (/** @type {unknown} */ (r));
}

/** @param {Cache[]} caches @param {Replacement[]} receipts @param {Policy} rules @returns {Candidate[]} */
function replacements(caches, receipts, rules) {
  /** @type {Candidate[]} */
  const result = [];
  const seen = new Set();
  const protectedKeys = new Set(receipts.map((r) => r.key));
  for (const receipt of receipts) {
    const base = rules.families[text(receipt.family)];
    const prefix = text(receipt.prefix);
    if (
      !base ||
      !prefix.startsWith(base) ||
      prefix.length <= base.length + 3 ||
      !prefix.endsWith("-")
    ) {
      throw new Error("Replacement does not identify a concrete compatible family");
    }
    if (seen.has(receipt.family) || !text(receipt.key).startsWith(prefix))
      throw new Error("Invalid replacement identity");
    seen.add(receipt.family);
    const matches = caches.filter(
      (c) => c.ref === `refs/heads/${rules.defaultBranch}` && c.key === receipt.key,
    );
    if (matches.length !== 1 || matches[0].size_in_bytes === 0) continue;
    const replacement = matches[0];
    for (const c of caches) {
      if (
        protectedKeys.has(c.key) ||
        c.ref !== replacement.ref ||
        Date.parse(c.created_at) >= Date.parse(replacement.created_at)
      )
        continue;
      const obsolete = c.version === replacement.version && c.key.startsWith(prefix);
      const retired = rules.retiredPrefixes.some(
        (r) => r.replacement === receipt.family && c.key.startsWith(r.prefix),
      );
      if (obsolete || retired)
        result.push({
          cache: c,
          replacement,
          reason: retired ? "retired namespace" : "superseded generation",
        });
    }
  }
  return result;
}

/** @param {Cache} c */
function codeqlIdentity(c) {
  const m = /^(codeql-overlay-base-database-\d+-.+)-([a-f0-9]{40})-(\d+)-(\d+)$/.exec(c.key);
  return m ? { family: m[1], sha: m[2], runId: Number(m[3]), attempt: Number(m[4]) } : null;
}

/** @param {Run} r @param {{name:string,path:string}[]} workflows */
function trustedRun(r, workflows) {
  return (
    r.status === "completed" &&
    r.conclusion === "success" &&
    workflows.some((w) => w.name === r.name && w.path === r.path.split("@")[0])
  );
}

/** @param {Cache[]} caches @param {Run[]} runs @param {Policy} rules @param {string} head @returns {Candidate[]} */
function codeql(caches, runs, rules, head) {
  /** @type {Candidate[]} */
  const result = [];
  /** @type {Map<string, Cache>} */
  const latest = new Map();
  for (const replacement of caches) {
    const current = codeqlIdentity(replacement);
    if (
      !current ||
      current.sha !== head ||
      replacement.ref !== `refs/heads/${rules.defaultBranch}` ||
      !replacement.size_in_bytes
    )
      continue;
    const proof = runs.find(
      (r) =>
        r.id === current.runId &&
        r.run_attempt === current.attempt &&
        r.head_sha === head &&
        r.head_branch === rules.defaultBranch,
    );
    if (!proof || !trustedRun(proof, rules.codeqlWorkflows)) continue;
    const previous = latest.get(current.family);
    if (!previous || Date.parse(previous.created_at) < Date.parse(replacement.created_at))
      latest.set(current.family, replacement);
  }
  for (const [family, replacement] of latest) {
    for (const c of caches) {
      const previous = codeqlIdentity(c);
      if (
        previous?.family === family &&
        c.ref === replacement.ref &&
        c.version === replacement.version &&
        Date.parse(c.created_at) < Date.parse(replacement.created_at) &&
        c.id !== replacement.id
      ) {
        result.push({ cache: c, replacement, reason: "superseded CodeQL snapshot" });
      }
    }
  }
  return result;
}

module.exports = {
  object,
  text,
  identifier,
  policy,
  cache,
  run,
  replacements,
  codeqlIdentity,
  codeql,
};
