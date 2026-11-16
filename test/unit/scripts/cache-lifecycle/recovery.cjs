"use strict";

const path = require("node:path");
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

function fixture() {
  const state = {
    runs: [
      {
        id: 10,
        run_attempt: 2,
        name: "Warm",
        path: ".github/workflows/warm.yml",
        head_sha: HEAD,
        head_branch: "main",
        event: "push",
        status: "completed",
        conclusion: "success",
      },
    ],
    jobs: [{ name: "warm", status: "completed", conclusion: "success" }],
    receipts: /** @type {unknown} */ ([
      { family: "npm", key: "npm-v1-Linux-X64-current", prefix: "npm-v1-Linux-X64-" },
    ]),
    downloads: /** @type {number[][]} */ ([]),
    routes: /** @type {string[]} */ ([]),
    totalCount: 1,
    comparison: {
      base_commit: { sha: OLD },
      merge_base_commit: { sha: OLD },
      status: "ahead",
      ahead_by: 1,
      total_commits: 1,
      commits: [{ sha: HEAD }],
      files: /** @type {{filename:string,previous_filename?:string}[]} */ ([
        { filename: "src/page.ts" },
      ]),
    },
  };
  const options = {
    api: {
      /** @param {string} route */
      list(route) {
        state.routes.push(route);
        if (route.includes("/jobs?")) return state.jobs;
        throw new Error(`Unexpected paginated recovery request: ${route}`);
      },
      /** @param {string} route */
      read(route) {
        state.routes.push(route);
        if (route.includes("/actions/runs?"))
          return {
            total_count: state.totalCount,
            workflow_runs: route.includes("head_sha=")
              ? state.runs.filter((r) => r.head_sha === HEAD)
              : state.runs,
          };
        return state.comparison;
      },
      /** @param {number} id @param {number} attempt */
      readReceipts(id, attempt) {
        state.downloads.push([id, attempt]);
        return state.receipts;
      },
    },
  };
  const rules = {
    defaultBranch: "main",
    producerWorkflows: [{ name: "Warm", path: ".github/workflows/warm.yml", job: "warm" }],
    families: { npm: "npm-v1-" },
    retiredPrefixes: [],
    producerInputs: ["package-lock.json", ".github/workflows/", "scripts/warm.cjs"],
  };
  return { state, options, rules };
}

/** @param {(name:string,fn:()=>void)=>unknown} test @param {typeof import('node:assert/strict')} assert @param {string} directory */
function registerRecoveryTests(test, assert, directory) {
  const { recoverReceipts } = require(path.join(directory, "recovery.cjs"));
  test("recovery reads receipts only from the latest successful trusted main producer attempt", () => {
    const { state, options, rules } = fixture();
    state.runs.unshift({ ...state.runs[0], id: 9, run_attempt: 1 });
    state.runs.push({ ...state.runs[0], id: 11, head_sha: OLD });
    assert.deepEqual(
      recoverReceipts(options, rules, "repos/example/project", HEAD),
      state.receipts,
    );
    assert.deepEqual(state.downloads, [[10, 2]]);
    assert.ok(state.routes[0].includes(`head_sha=${HEAD}&branch=main&status=success`));
    assert.ok(state.routes[1].endsWith("/runs/10/attempts/2/jobs?per_page=100"));
    assert.equal(
      state.routes.some((route) => route.includes("/compare/")),
      false,
    );
  });
  test("failed, PR and unlisted producers cannot supply recovery receipts", () => {
    for (const change of ["failure", "active", "pr", "branch", "name", "path", "empty"]) {
      const { state, options, rules } = fixture();
      if (change === "failure") state.runs[0].conclusion = "failure";
      if (change === "active") state.runs[0].status = "in_progress";
      if (change === "pr") state.runs[0].event = "pull_request";
      if (change === "branch") state.runs[0].head_branch = "feature";
      if (change === "name") state.runs[0].name = "Other";
      if (change === "path") state.runs[0].path = ".github/workflows/other.yml";
      if (change === "empty") state.runs = [];
      assert.deepEqual(recoverReceipts(options, rules, "repos/example/project", HEAD), [], change);
      assert.deepEqual(state.downloads, []);
    }
  });
  test("recovery requires the exact successful attempt job and bounded valid receipts", () => {
    for (const change of [
      "attempt",
      "job",
      "job-status",
      "job-name",
      "shape",
      "size",
      "family",
      "duplicate",
      "candidates",
    ]) {
      const { state, options, rules } = fixture();
      if (change === "attempt") state.runs[0].run_attempt = 0;
      if (change === "job") state.jobs[0].conclusion = "failure";
      if (change === "job-status") state.jobs[0].status = "in_progress";
      if (change === "job-name") state.jobs[0].name = "other";
      if (change === "shape") state.receipts = {};
      if (change === "size") state.receipts = Array(21).fill({});
      if (change === "family")
        state.receipts = [{ family: "other", key: "other-current", prefix: "other-" }];
      if (change === "duplicate")
        state.receipts = Array(2).fill({
          family: "npm",
          key: "npm-v1-Linux-X64-current",
          prefix: "npm-v1-Linux-X64-",
        });
      if (change === "candidates") state.runs = Array(21).fill(state.runs[0]);
      assert.throws(
        () => recoverReceipts(options, rules, "repos/example/project", HEAD),
        Error,
        change,
      );
      if (["attempt", "job", "job-status", "job-name", "candidates"].includes(change))
        assert.deepEqual(state.downloads, []);
    }
  });
}

/** @param {(name:string,fn:()=>void)=>unknown} test @param {typeof import('node:assert/strict')} assert @param {string} directory */
function registerAncestryTests(test, assert, directory) {
  const { recoverReceipts } = require(path.join(directory, "recovery.cjs"));
  test("recovery searches only the latest twenty runs despite a large historical total", () => {
    const { state, options, rules } = fixture();
    state.runs[0].head_sha = OLD;
    state.totalCount = 1000;
    state.runs.push(
      ...[...Array(19).keys()].map((i) => ({ ...state.runs[0], id: 100 + i, name: "Other" })),
    );
    assert.deepEqual(
      recoverReceipts(options, rules, "repos/example/project", HEAD),
      state.receipts,
    );
    assert.deepEqual(state.downloads, [[10, 2]]);
    const searches = state.routes.filter((route) => route.includes("/actions/runs?"));
    assert.equal(searches.length, 2);
    assert.ok(searches.every((route) => route.endsWith("per_page=20")));
  });
  test("unchanged producer inputs permit recovery after unrelated main commits", () => {
    const { state, options, rules } = fixture();
    state.runs[0].head_sha = OLD;
    assert.deepEqual(
      recoverReceipts(options, rules, "repos/example/project", HEAD),
      state.receipts,
    );
    assert.deepEqual(state.downloads, [[10, 2]]);
    assert.ok(state.routes.includes(`repos/example/project/compare/${OLD}...${HEAD}?per_page=100`));
  });
  test("protected changes, renames and incomplete or nonancestor comparisons preserve old caches", () => {
    for (const change of [
      "lock",
      "directory",
      "rename",
      "files",
      "commits",
      "endpoint",
      "base",
      "ancestor",
      "status",
      "ahead",
      "limit",
    ]) {
      const { state, options, rules } = fixture();
      state.runs[0].head_sha = OLD;
      if (change === "lock") state.comparison.files = [{ filename: "package-lock.json" }];
      if (change === "directory")
        state.comparison.files = [{ filename: ".github/workflows/warm.yml" }];
      if (change === "rename") state.comparison.files[0].previous_filename = "scripts/warm.cjs";
      if (change === "files")
        state.comparison.files = Array(300).fill({ filename: "src/other.ts" });
      if (change === "commits") state.comparison.total_commits = 2;
      if (change === "endpoint") state.comparison.commits[0].sha = OLD;
      if (change === "base") state.comparison.base_commit.sha = HEAD;
      if (change === "ancestor") state.comparison.merge_base_commit.sha = HEAD;
      if (change === "status") state.comparison.status = "diverged";
      if (change === "ahead") state.comparison.ahead_by = 2;
      if (change === "limit") state.comparison.total_commits = 101;
      assert.deepEqual(recoverReceipts(options, rules, "repos/example/project", HEAD), [], change);
      assert.deepEqual(state.downloads, []);
    }
  });
}

/** @param {(name:string,fn:()=>void)=>unknown} test @param {typeof import('node:assert/strict')} assert @param {string} directory */
function registerAllRecoveryTests(test, assert, directory) {
  registerRecoveryTests(test, assert, directory);
  registerAncestryTests(test, assert, directory);
}

module.exports = { registerRecoveryTests: registerAllRecoveryTests };
