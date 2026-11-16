"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

/** @param {number} id @param {string} key @param {Record<string, unknown>} patch */
function cache(id, key, patch = {}) {
  return {
    id,
    key,
    ref: "refs/heads/main",
    version: "format-1",
    size_in_bytes: 100,
    created_at: `2026-11-${id === 2 ? "16" : "15"}T10:00:00Z`,
    last_accessed_at: "2026-11-16T10:00:00Z",
    ...patch,
  };
}

/** @param {number} id @param {Record<string, unknown>} patch */
function run(id, patch = {}) {
  return {
    id,
    name: "Warm",
    path: ".github/workflows/warm.yml",
    head_sha: HEAD,
    head_branch: "main",
    run_attempt: 1,
    event: "push",
    status: "in_progress",
    conclusion: null,
    ...patch,
  };
}

function fixture() {
  const state = {
    caches: [cache(1, "npm-v1-Linux-X64-node26-old"), cache(2, "npm-v1-Linux-X64-node26-current")],
    active: /** @type {ReturnType<typeof run>[]} */ ([]),
    runs: /** @type {Record<number, ReturnType<typeof run>>} */ ({ 99: run(99) }),
    jobs: [{ name: "warm", status: "completed", conclusion: "success" }],
    prs: /** @type {Record<number, {state:string,head:{sha:string,ref:string}}>} */ ({}),
    removed: /** @type {number[]} */ ([]),
    main: HEAD,
    inventoryReads: 0,
    activeReads: 0,
    beforeRefresh: /** @type {undefined | (() => void)} */ (undefined),
    removeWorks: true,
  };
  const api = {
    /** @returns {unknown[]} */
    readReceipts() {
      return [];
    },
    /** @param {string} route @returns {unknown} */
    read(route) {
      if (route === "repos/example/project")
        return { full_name: "example/project", default_branch: "main" };
      if (route.includes("/git/ref/")) return { object: { sha: state.main } };
      if (route.includes("/actions/runs?")) return { workflow_runs: [] };
      const pr = /\/pulls\/(\d+)$/.exec(route);
      if (pr) return state.prs[Number(pr[1])];
      const match = /\/actions\/runs\/(\d+)$/.exec(route);
      if (match && state.runs[Number(match[1])]) return state.runs[Number(match[1])];
      throw new Error(`Unexpected fixture read ${route}`);
    },
    /** @param {string} route */
    list(route) {
      if (route.includes("/jobs?")) return structuredClone(state.jobs);
      if (route.includes("/actions/caches?")) {
        state.inventoryReads += 1;
        if (state.inventoryReads === 2) state.beforeRefresh?.();
        return structuredClone(state.caches);
      }
      if (route.includes("/actions/runs?")) {
        state.activeReads += 1;
        return route.includes("status=in_progress") ? structuredClone(state.active) : [];
      }
      throw new Error(`Unexpected fixture list ${route}`);
    },
    /** @param {number} id */
    remove(id) {
      state.removed.push(id);
      if (state.removeWorks) state.caches = state.caches.filter((c) => c.id !== id);
    },
  };
  const options = {
    policy: {
      schemaVersion: 1,
      producerInputs: ["package.json", "package-lock.json", ".github/actions/"],
      repository: "example/project",
      defaultBranch: "main",
      producerWorkflows: [{ name: "Warm", path: ".github/workflows/warm.yml", job: "warm" }],
      families: { npm: "npm-v1-" },
      codeqlWorkflows: [{ name: "CodeQL", path: ".github/workflows/codeql.yml" }],
      retiredPrefixes: /** @type {{prefix:string,replacement:string}[]} */ ([]),
    },
    repository: "example/project",
    eventName: "push",
    event: /** @type {Record<string, unknown>} */ ({}),
    workflow: "Warm",
    runId: 99,
    ref: "refs/heads/main",
    sha: HEAD,
    checkoutSha: HEAD,
    replacements: [
      { family: "npm", key: "npm-v1-Linux-X64-node26-current", prefix: "npm-v1-Linux-X64-node26-" },
    ],
    api,
    dryRun: false,
  };
  return { state, options };
}

/** @param {Record<string, unknown>} patch */
function codeqlFixture(patch) {
  const result = fixture();
  const prefix = "codeql-overlay-base-database-1-config-javascript-2.27.4";
  result.state.caches = [cache(1, `${prefix}-${OLD}-9-1`), cache(2, `${prefix}-${HEAD}-10-1`)];
  result.state.runs[10] = run(10, {
    name: "CodeQL",
    path: ".github/workflows/codeql.yml",
    status: "completed",
    conclusion: "success",
    ...patch,
  });
  return result;
}

/** @param {(name:string,fn:()=>void)=>unknown} test @param {typeof import('node:assert/strict')} assert @param {string} directory */
function registerProducerTests(test, assert, directory) {
  const { runLifecycle } = require(path.join(directory, "core.cjs"));
  test("a successful producer retires only replaced compatible main generations", () => {
    const { state, options } = fixture();
    state.caches.push(cache(3, "npm-v1-Windows-X64-node26-old"), cache(4, "unknown-store"));
    const result = runLifecycle(options);
    assert.deepEqual(state.removed, [1]);
    assert.equal(result.remainingCount, 3);
  });
  test("missing, empty or ambiguous replacement caches preserve old entries", () => {
    for (const mode of ["missing", "empty", "ambiguous"]) {
      const { state, options } = fixture();
      if (mode === "missing") state.caches.splice(1, 1);
      if (mode === "empty") state.caches[1].size_in_bytes = 0;
      if (mode === "ambiguous") state.caches.push(cache(3, options.replacements[0].key));
      runLifecycle(options);
      assert.deepEqual(state.removed, []);
    }
  });
  test("failed producer jobs, wrong workflows and stale checkout contexts fail closed", () => {
    for (const change of ["job", "path", "sha", "repository", "ref", "checkout"]) {
      const { state, options } = fixture();
      if (change === "job") state.jobs[0].conclusion = "failure";
      if (change === "path") state.runs[99].path = ".github/workflows/other.yml";
      if (change === "sha") options.sha = OLD;
      if (change === "repository") options.repository = "untrusted/fork";
      if (change === "ref") options.ref = "refs/pull/1/merge";
      if (change === "checkout") options.checkoutSha = OLD;
      assert.throws(() => runLifecycle(options));
      assert.deepEqual(state.removed, []);
    }
  });
  test("unsupported and still-running workflow events cannot authorize deletion", () => {
    for (const mode of ["unsupported", "running"]) {
      const { state, options } = fixture();
      options.eventName = mode === "unsupported" ? "pull_request" : "workflow_run";
      options.event = { action: "completed", workflow_run: { id: 99 } };
      assert.throws(() => runLifecycle(options));
      assert.deepEqual(state.removed, []);
    }
  });
}

/** @param {(name:string,fn:()=>void)=>unknown} test @param {typeof import('node:assert/strict')} assert @param {string} directory */
function registerPrTests(test, assert, directory) {
  const { runLifecycle } = require(path.join(directory, "core.cjs"));
  test("an unrelated completed workflow retries metadata cleanup without trusting its receipts", () => {
    const { state, options } = fixture();
    state.runs[10] = run(10, {
      name: "Release",
      path: ".github/workflows/release.yml",
      status: "completed",
      conclusion: "success",
    });
    options.eventName = "workflow_run";
    options.event = { action: "completed", workflow_run: { id: 10 } };
    runLifecycle(options);
    assert.deepEqual(state.removed, []);
  });
  test("open PR refs and active closed PR refs are protected", () => {
    const { state, options } = fixture();
    state.caches = [
      cache(3, "anything", { ref: "refs/pull/7/merge" }),
      cache(4, "anything", { ref: "refs/pull/8/head" }),
    ];
    state.prs[7] = { state: "open", head: { sha: OLD, ref: "feature" } };
    state.prs[8] = { state: "closed", head: { sha: OLD, ref: "feature" } };
    state.active = [run(10, { head_sha: OLD, head_branch: "feature" })];
    runLifecycle(options);
    assert.deepEqual(state.removed, []);
    state.active = [];
    runLifecycle(options);
    assert.deepEqual(state.removed, [4]);
  });
  test("closed PR metadata cleanup never promotes main replacement receipts", () => {
    const { state, options } = fixture();
    options.eventName = "pull_request_target";
    options.event = { action: "closed", pull_request: { number: 7 } };
    state.caches.push(cache(3, "pr-only", { ref: "refs/pull/7/merge" }));
    state.prs[7] = { state: "closed", head: { sha: OLD, ref: "feature" } };
    runLifecycle(options);
    assert.deepEqual(state.removed, [3]);
  });
  test("PR reopen and newly started runs during planning preserve candidate caches", () => {
    for (const mode of ["reopen", "active"]) {
      const { state, options } = fixture();
      state.caches = [cache(3, "pr", { ref: "refs/pull/7/merge" })];
      state.prs[7] = { state: "closed", head: { sha: OLD, ref: "feature" } };
      state.beforeRefresh = () => {
        if (mode === "reopen") state.prs[7].state = "open";
        else state.active = [run(10, { head_sha: OLD })];
      };
      runLifecycle(options);
      assert.deepEqual(state.removed, []);
    }
  });
}

/** @param {(name:string,fn:()=>void)=>unknown} test @param {typeof import('node:assert/strict')} assert @param {string} directory */
function registerRotationTests(test, assert, directory) {
  const { runLifecycle } = require(path.join(directory, "core.cjs"));
  test("active other workflows defer main rotation while the lifecycle itself is ignored", () => {
    const { state, options } = fixture();
    state.active = [run(99)];
    runLifecycle(options);
    assert.deepEqual(state.removed, [1]);
    const busy = fixture();
    busy.state.active = [run(100)];
    runLifecycle(busy.options);
    assert.deepEqual(busy.state.removed, []);
  });
  test("completion events recover a main rotation deferred while other runs were active", () => {
    const { state, options } = fixture();
    state.active = [run(101)];
    assert.equal(runLifecycle(options).deferred, 1);
    assert.deepEqual(state.removed, []);
    state.active = [];
    state.runs[10] = run(10, { status: "completed", conclusion: "success" });
    options.eventName = "workflow_run";
    options.event = { action: "completed", workflow_run: { id: 10 } };
    options.api.readReceipts = () => options.replacements;
    const read = options.api.read;
    options.api.read = (route) =>
      route.includes("status=success") ? { workflow_runs: [state.runs[10]] } : read(route);
    runLifecycle(options);
    assert.deepEqual(state.removed, [1]);
  });
  test("replacement disappearance, last-access changes and main movement stop stale plans", () => {
    for (const mode of ["replacement", "access", "main"]) {
      const { state, options } = fixture();
      state.beforeRefresh = () => {
        if (mode === "replacement") state.caches.pop();
        if (mode === "access") state.caches[0].last_accessed_at = "2026-11-16T11:00:00Z";
        if (mode === "main") state.main = OLD;
      };
      if (mode === "main") assert.throws(() => runLifecycle(options));
      else runLifecycle(options);
      assert.deepEqual(state.removed, []);
    }
  });
  test("explicit retired namespaces need their declared functional replacement", () => {
    const { state, options } = fixture();
    options.policy.retiredPrefixes = [{ prefix: "legacy-npm-", replacement: "npm" }];
    state.caches = [cache(1, "legacy-npm-old"), state.caches[1]];
    runLifecycle(options);
    assert.deepEqual(state.removed, [1]);
  });
}

/** @param {(name:string,fn:()=>void)=>unknown} test @param {typeof import('node:assert/strict')} assert @param {string} directory */
function registerCodeqlTests(test, assert, directory) {
  const { runLifecycle } = require(path.join(directory, "core.cjs"));
  test("CodeQL keeps the latest verified snapshot and protects different configurations", () => {
    const { state, options } = fixture();
    options.eventName = "workflow_run";
    options.event = { action: "completed", workflow_run: { id: 10 } };
    state.runs[10] = run(10, {
      name: "CodeQL",
      path: ".github/workflows/codeql.yml",
      status: "completed",
      conclusion: "success",
    });
    const prefix = "codeql-overlay-base-database-1-config-javascript-2.27.4";
    state.caches = [
      cache(1, `${prefix}-${OLD}-9-1`),
      cache(2, `${prefix}-${HEAD}-10-1`),
      cache(3, `codeql-overlay-base-database-1-other-javascript-2.27.4-${OLD}-8-1`),
    ];
    runLifecycle(options);
    assert.deepEqual(state.removed, [1]);
  });
  test("a successful rerun cannot authorize a snapshot from its failed previous attempt", () => {
    const { state, options } = codeqlFixture({ run_attempt: 2 });
    runLifecycle(options);
    assert.deepEqual(state.removed, []);
  });
  test("failed CodeQL runs cannot retire snapshots", () => {
    const { state, options } = codeqlFixture({ conclusion: "failure" });
    runLifecycle(options);
    assert.deepEqual(state.removed, []);
  });
}

/** @param {(name:string,fn:()=>void)=>unknown} test @param {typeof import('node:assert/strict')} assert @param {string} directory */
function registerSafetyTests(test, assert, directory) {
  const { runLifecycle } = require(path.join(directory, "core.cjs"));
  const planner = require(path.join(directory, "planner.cjs"));
  test("API failures and malformed inventories delete nothing", () => {
    for (const mode of ["failure", "shape"]) {
      const { state, options } = fixture();
      if (mode === "failure")
        options.api.list = () => {
          throw new Error("API unavailable");
        };
      else state.caches[0].last_accessed_at = "invalid";
      assert.throws(() => runLifecycle(options));
      assert.deepEqual(state.removed, []);
    }
  });
  test("dry-run plans changes without writes and deletion readback failures are visible", () => {
    const { state, options } = fixture();
    options.dryRun = true;
    assert.equal(runLifecycle(options).deleted.length, 1);
    assert.deepEqual(state.removed, []);
    options.dryRun = false;
    state.removeWorks = false;
    assert.throws(() => runLifecycle(options), /readback/);
  });
  test("malformed policy and broad replacement prefixes fail closed", () => {
    for (const mode of ["repository", "mapping", "prefix", "duplicate"]) {
      const { state, options } = fixture();
      if (mode === "repository") options.policy.repository = "../other";
      if (mode === "mapping")
        options.policy.retiredPrefixes = [{ prefix: "legacy-npm-", replacement: "missing" }];
      if (mode === "prefix") options.replacements[0].prefix = "npm-v1-";
      if (mode === "duplicate") options.replacements.push(options.replacements[0]);
      assert.throws(() => runLifecycle(options));
      assert.deepEqual(state.removed, []);
    }
    assert.throws(() => planner.identifier(-1));
    assert.throws(() => planner.object([]));
  });
}

/** @param {(name:string,fn:()=>void)=>unknown} test @param {typeof import('node:assert/strict')} assert @param {string} directory */
function registerTransportTests(test, assert, directory) {
  const { createGhApi } = require(path.join(directory, "github.cjs"));
  const { main } = require(path.join(directory, "run.cjs"));
  test("GitHub adapter uses bounded native GET/pagination and cache-ID-only DELETE", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cache-lifecycle-transport-"));
    const oldPath = process.env.PATH;
    const log = path.join(root, "calls.jsonl");
    const executable = path.join(root, "gh");
    const script = `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a.includes('--slurp'))console.log(JSON.stringify([{actions_caches:[{id:1}]},{actions_caches:[{id:2}]}]));else if(a.includes('GET'))console.log('{}');`;
    fs.writeFileSync(executable, script, { mode: 0o755 });
    process.env.PATH = `${root}${path.delimiter}${oldPath}`;
    try {
      const api = createGhApi("example/project");
      assert.deepEqual(api.read("repos/example/project"), {});
      assert.equal(
        api.list("repos/example/project/actions/caches?per_page=100", "actions_caches").length,
        2,
      );
      api.remove(5);
      assert.throws(() => api.read("repos/example/project-evil/actions/caches"));
      assert.throws(() => api.remove(0));
      const calls = fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(calls.length, 3);
      assert.ok(calls[2].includes("DELETE"));
      assert.equal(calls[2].at(-1), "repos/example/project/actions/caches/5");
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  test("CLI refuses incidental local execution before reading policy or touching GitHub", () => {
    assert.throws(() => main({}, []), /GitHub Actions context/);
    assert.throws(() => main({ GITHUB_ACTIONS: "true" }, []), /Usage/);
  });
}

/** @param {(name:string,fn:()=>void)=>unknown} test @param {typeof import('node:assert/strict')} assert @param {string} directory */
function registerCodeqlIsolationTests(test, assert, directory) {
  const { runLifecycle } = require(path.join(directory, "core.cjs"));
  test("untrusted PR keys cannot request CodeQL proofs or exhaust their budget", () => {
    const { state, options } = fixture();
    state.caches = [...Array(26).keys()].map((i) =>
      cache(100 + i, `codeql-overlay-base-database-1-fake-${HEAD}-${1000 + i}-1`, {
        ref: "refs/pull/7/merge",
      }),
    );
    state.prs[7] = { state: "closed", head: { sha: OLD, ref: "feature" } };
    runLifecycle(options);
    assert.equal(state.removed.length, 26);
  });
  test("each CodeQL cache version retains its own verified replacement", () => {
    const { state, options } = codeqlFixture({});
    const [old, replacement] = state.caches;
    state.caches.push(
      { ...old, id: 3, version: "format-2" },
      { ...replacement, id: 4, version: "format-2" },
    );
    runLifecycle(options);
    assert.deepEqual(state.removed, [1, 3]);
    assert.deepEqual(
      state.caches.map((c) => c.id),
      [2, 4],
    );
  });
}

/** @param {(name:string,fn:()=>void)=>unknown} test @param {typeof import('node:assert/strict')} assert @param {string} directory */
function registerTests(test, assert, directory) {
  for (const register of [
    registerProducerTests,
    registerPrTests,
    registerRotationTests,
    registerCodeqlTests,
    registerCodeqlIsolationTests,
    registerSafetyTests,
  ])
    register(test, assert, directory);
}

module.exports = { registerTests, registerTransportTests };
