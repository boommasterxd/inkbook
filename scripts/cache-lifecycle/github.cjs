"use strict";

const { execFileSync } = require("node:child_process");
const { identifier } = require("./planner.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** @param {string[]} args @returns {string} */
function invoke(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("GitHub cache API request failed; no unchecked deletion will be retried");
  }
}

/** @param {string} repository @returns {import('./types').Api} */
function createGhApi(repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
  const base = `repos/${repository}/`;
  /** @param {string} path @param {string[]} flags */
  const request = (path, flags) => {
    if ((path !== base.slice(0, -1) && !path.startsWith(base)) || /[\r\n\0]/.test(path)) {
      throw new Error("API request outside target repository");
    }
    return invoke(["api", "-H", "X-GitHub-Api-Version: 2026-03-10", ...flags, path]);
  };
  /** @type {import('./types').Api} */
  const api = {
    read: (path) => JSON.parse(request(path, ["--method", "GET"])),
    list: (path, field) => {
      const pages = JSON.parse(request(path, ["--method", "GET", "--paginate", "--slurp"]));
      if (!Array.isArray(pages) || pages.length > 50)
        throw new Error("Incomplete or oversized GitHub inventory");
      return pages.flatMap((page) => {
        const rows = Array.isArray(page) ? page : page[field];
        if (!Array.isArray(rows)) throw new Error("Malformed paginated GitHub inventory");
        return rows;
      });
    },
    remove: (id) => {
      request(`${base}actions/caches/${identifier(id)}`, ["--method", "DELETE"]);
    },
    readReceipts: (runId, attempt) => downloadReceipts(api, repository, runId, attempt),
  };
  return api;
}

/** @param {import('./types').Api} api @param {string} repository @param {number} runId @param {number} attempt */
function downloadReceipts(api, repository, runId, attempt) {
  const name = `cache-lifecycle-receipts-${identifier(attempt)}`;
  const artifacts = api
    .list(
      `repos/${repository}/actions/runs/${identifier(runId)}/artifacts?per_page=100`,
      "artifacts",
    )
    .map((item) => /** @type {Record<string, unknown>} */ (item))
    .filter((item) => item.name === name);
  if (!artifacts.length) return [];
  if (
    artifacts.length !== 1 ||
    artifacts[0].expired !== false ||
    !Number.isSafeInteger(artifacts[0].size_in_bytes) ||
    Number(artifacts[0].size_in_bytes) > 131072
  ) {
    throw new Error("Invalid or ambiguous producer receipt artifact");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cache-lifecycle-receipts-"));
  try {
    invoke([
      "run",
      "download",
      String(runId),
      "--name",
      name,
      "--dir",
      directory,
      "--repo",
      repository,
    ]);
    const file = path.join(directory, "replacements.json");
    if (fs.statSync(file).size > 65536) throw new Error("Producer receipt exceeds size budget");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(value) || value.length > 20) throw new Error("Invalid producer receipts");
    return value;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { createGhApi };
