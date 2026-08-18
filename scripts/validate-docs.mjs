import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { fail, listFiles } from "./lib-files.mjs";

const markdownFiles = (await listFiles("docs")).filter((file) =>
  file.endsWith(".md"),
);
const agents = await readFile("AGENTS.md", "utf8");
const indexPattern =
  /\[`(docs\/[^`]+\.md)`\]\((docs\/[^)]+\.md)\)\s*\|\s*([^|\n]+)/gu;
const indexEntries = [...agents.matchAll(indexPattern)];
const indexedFiles = indexEntries.map((entry) => entry[1]);

if (new Set(indexedFiles).size !== indexedFiles.length)
  fail("Duplicate Documentation Index entry");
if (
  JSON.stringify([...indexedFiles].sort()) !== JSON.stringify(markdownFiles)
) {
  fail("AGENTS.md Documentation Index does not exactly match docs/**/*.md");
}

for (const entry of indexEntries) {
  if (entry[1] !== entry[2])
    fail(`Documentation Index label mismatch: ${entry[1]}`);
  if (!entry[3]?.trim())
    fail(`Documentation Index purpose missing: ${entry[1]}`);
}

for (const file of ["AGENTS.md", ...markdownFiles]) {
  const content = await readFile(file, "utf8");
  if (content.includes("\u2014")) fail(`${file} contains a forbidden em dash`);
  if (
    content
      .split("\n")
      .some((line) => line.endsWith(" ") || line.endsWith("\t"))
  ) {
    fail(`${file} contains trailing whitespace`);
  }
  if (content.split("\n").length > 500) fail(`${file} exceeds 500 lines`);
  const fences = content.match(/^```/gmu)?.length ?? 0;
  if (fences % 2 !== 0) fail(`${file} contains an unmatched code fence`);
  await validateLocalLinks(file, content);
}

console.log(
  `Documentation validation passed for ${markdownFiles.length} indexed files.`,
);

async function validateLocalLinks(file, content) {
  const links = [...content.matchAll(/\]\(([^)\r\n]+)\)/gu)].map(
    (match) => match[1],
  );
  for (const rawLink of links) {
    if (/^(?:https?:|mailto:|#)/u.test(rawLink)) continue;
    const target = decodeURIComponent(rawLink.split("#", 1)[0] ?? "");
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), target);
    await access(resolved).catch(() =>
      fail(`${file} has a broken link to ${rawLink}`),
    );
  }
}
