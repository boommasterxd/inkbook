"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { runLifecycle } = require("./core.cjs");
const { createGhApi } = require("./github.cjs");

/** @param {NodeJS.ProcessEnv} env @param {string[]} args */
function main(env = process.env, args = process.argv.slice(2)) {
  if (env.GITHUB_ACTIONS !== "true")
    throw new Error("Lifecycle execution requires an explicit GitHub Actions context");
  if (!args[0] || args.length > 2 || (args[1] && args[1] !== "--dry-run"))
    throw new Error("Usage: run.cjs POLICY.json [--dry-run]");
  const policy = JSON.parse(fs.readFileSync(args[0], "utf8"));
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH || "", "utf8"));
  const replacements = JSON.parse(env.CACHE_REPLACEMENTS || "[]");
  if (!Array.isArray(replacements)) throw new Error("Replacement receipts must be an array");
  const checkoutSha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 5000,
  }).trim();
  const result = runLifecycle({
    policy,
    event,
    replacements,
    repository: env.GITHUB_REPOSITORY || "",
    eventName: env.GITHUB_EVENT_NAME || "",
    runId: Number(env.GITHUB_RUN_ID),
    ref: env.GITHUB_REF || "",
    sha: env.GITHUB_SHA || "",
    workflow: env.GITHUB_WORKFLOW || "",
    checkoutSha,
    api: createGhApi(env.GITHUB_REPOSITORY || ""),
    dryRun: args[1] === "--dry-run",
  });
  console.log(JSON.stringify(result));
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### Cache lifecycle\n\n${result.dryRun ? "Planned" : "Deleted"}: ${result.deleted.length}; deferred: ${result.deferred}; remaining: ${result.remainingCount} (${result.remainingBytes} bytes).\n`,
    );
  return result;
}

module.exports = { main };
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Cache cleanup failed");
    process.exitCode = 1;
  }
}
