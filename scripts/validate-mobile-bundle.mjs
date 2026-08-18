import { readFile } from "node:fs/promises";

import { fail } from "./lib-files.mjs";

const bundle = await readFile("main.js", "utf8");
const forbidden = [
  /require\(["'](?:node:)?(?:fs|path|os|child_process|worker_threads)["']\)/u,
  /require\(["']electron["']\)/u,
  /\bprocess\.versions\.electron\b/u,
  /\beval\s*\(/u,
  /\bnew\s+Function\s*\(/u,
  /https?:\/\//u,
];

for (const pattern of forbidden) {
  if (pattern.test(bundle))
    fail(`Mobile bundle contains forbidden pattern ${pattern}`);
}

console.log("Mobile bundle validation passed.");
