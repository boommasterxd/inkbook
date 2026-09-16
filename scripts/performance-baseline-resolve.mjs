import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const ref = "refs/tags/performance-baseline";
const result = execFileSync("git", ["ls-remote", "--refs", "origin", ref], {
  encoding: "utf8",
  timeout: 30_000,
}).trim();
const commit = result
  ? result.split(/\s+/)[0]
  : JSON.parse(readFileSync(".github/performance-policy.json", "utf8")).anchorCommit;
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid performance baseline SHA");
appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\n`);
