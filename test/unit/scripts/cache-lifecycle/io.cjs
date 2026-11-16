"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const HEAD = "a".repeat(40);

/** @param {(context:{root:string,state:Record<string,unknown>,save:()=>void})=>void} check */
function withCli(check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cache-lifecycle-io-"));
  const prior = process.env.PATH;
  const state = {
    mode: "valid",
    receipts: [{ family: "npm", key: "npm-v1-Linux-X64-new", prefix: "npm-v1-Linux-X64-" }],
  };
  const file = path.join(root, "state.json");
  const save = () => fs.writeFileSync(file, JSON.stringify(state));
  const script = `#!${process.execPath}
const fs = require('node:fs');const path = require('node:path');const args=process.argv.slice(2);const state=JSON.parse(fs.readFileSync(${JSON.stringify(file)},'utf8'));
if(state.mode==='failure')process.exit(1);
if(args[0]==='run'){fs.writeFileSync(path.join(args[args.indexOf('--dir')+1],'replacements.json'),state.mode==='oversized'?' '.repeat(65537):JSON.stringify(state.receipts));process.exit(0);}
const route=args.at(-1);let result={};
if(route.includes('/artifacts?')){const a={name:'cache-lifecycle-receipts-2',expired:false,size_in_bytes:200};result={artifacts:state.mode==='missing'?[]:state.mode==='ambiguous'?[a,a]:[{...a,expired:state.mode==='expired'}]};}
else if(route.includes('/actions/caches?'))result={actions_caches:[]};
else if(route.includes('/actions/runs?'))result={workflow_runs:[]};
else if(route==='repos/example/project')result={full_name:'example/project',default_branch:'main'};
else if(route.includes('/git/ref/'))result={object:{sha:'${HEAD}'}};
if(state.mode==='malformed')result={broken:true};
console.log(JSON.stringify(args.includes('--slurp')?[result]:result));`;
  fs.writeFileSync(path.join(root, "gh"), script, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "git"), `#!${process.execPath}\nconsole.log('${HEAD}');`, {
    mode: 0o755,
  });
  process.env.PATH = `${root}${path.delimiter}${prior}`;
  save();
  try {
    check({ root, state, save });
  } finally {
    process.env.PATH = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** @param {(name:string,fn:()=>void)=>unknown} test @param {typeof import('node:assert/strict')} assert @param {string} directory */
function registerIoTests(test, assert, directory) {
  const { createGhApi } = require(path.join(directory, "github.cjs"));
  test("receipt download binds its attempt and rejects ambiguous, expired, oversized or invalid data", () => {
    withCli(({ state, save }) => {
      const api = createGhApi("example/project");
      assert.deepEqual(api.readReceipts(10, 2), state.receipts);
      state.mode = "missing";
      save();
      assert.deepEqual(api.readReceipts(10, 2), []);
      for (const mode of ["ambiguous", "expired", "oversized", "failure", "malformed"]) {
        state.mode = mode;
        save();
        assert.throws(() => api.readReceipts(10, 2));
      }
      state.mode = "valid";
      state.receipts = /** @type {never} */ ({});
      save();
      assert.throws(() => api.readReceipts(10, 2));
      state.receipts = Array(21).fill({});
      save();
      assert.throws(() => api.readReceipts(10, 2));
    });
  });
  test("CLI completes a metadata dry-run, writes a truthful summary and rejects invalid receipt input", () => {
    withCli(({ root }) => {
      const policy = {
        schemaVersion: 1,
        producerInputs: ["package.json", "package-lock.json", ".github/actions/"],
        repository: "example/project",
        defaultBranch: "main",
        producerWorkflows: [],
        families: { npm: "npm-v1-" },
        codeqlWorkflows: [],
        retiredPrefixes: [],
      };
      const policyFile = path.join(root, "policy.json");
      const eventFile = path.join(root, "event.json");
      const summary = path.join(root, "summary.md");
      fs.writeFileSync(policyFile, JSON.stringify(policy));
      fs.writeFileSync(
        eventFile,
        JSON.stringify({ action: "closed", pull_request: { number: 7 } }),
      );
      const env = {
        ...process.env,
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "example/project",
        GITHUB_EVENT_NAME: "pull_request_target",
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_RUN_ID: "99",
        GITHUB_STEP_SUMMARY: summary,
        CACHE_REPLACEMENTS: "[]",
      };
      const result = spawnSync(
        process.execPath,
        [path.join(directory, "run.cjs"), policyFile, "--dry-run"],
        { env, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).dryRun, true);
      assert.match(fs.readFileSync(summary, "utf8"), /Planned: 0/);
      env.CACHE_REPLACEMENTS = "{}";
      const invalid = spawnSync(process.execPath, [path.join(directory, "run.cjs"), policyFile], {
        env,
        encoding: "utf8",
      });
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /must be an array/);
    });
  });
}

module.exports = { registerIoTests };
