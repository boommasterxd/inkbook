import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";

import { fail } from "./lib-files.mjs";

const OUTPUT_PATH = "test/traceability/requirements.json";
const checkOnly = process.argv.includes("--check");
const indexedPaths = await readIndexedPaths();
const requirements = [];
const specificationParts = [];

for (const filePath of indexedPaths) {
  const content = await readFile(filePath, "utf8");
  specificationParts.push(`${filePath}\0${digest(content)}`);
  requirements.push(...extractRequirements(filePath, content));
}

const ids = new Map();
for (const requirement of requirements) {
  const prior = ids.get(requirement.id);
  if (prior && prior.fullSha256 !== requirement.fullSha256) {
    fail(`Requirement ID collision: ${requirement.id}`);
  }
  ids.set(requirement.id, requirement);
}

const manifest = {
  generatorVersion: "1.0.0",
  specificationSha256: digest(specificationParts.join("\0")),
  requirements,
};
const output = `${JSON.stringify(manifest, null, 2)}\n`;

if (checkOnly) {
  const current = await readFile(OUTPUT_PATH, "utf8").catch(() => "");
  if (current !== output)
    fail("Traceability manifest is stale; run npm run traceability:generate");
  console.log(
    `Traceability validation passed for ${requirements.length} requirements.`,
  );
} else {
  await writeFile(OUTPUT_PATH, output, "utf8");
  console.log(`Generated ${requirements.length} requirement records.`);
}

async function readIndexedPaths() {
  const agents = await readFile("AGENTS.md", "utf8");
  const matches = [...agents.matchAll(/\[`(docs\/[^`]+\.md)`\]\([^)]+\)/gu)];
  return matches.map((match) => match[1]);
}

function extractRequirements(filePath, content) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(content);
  const headings = [];
  const clauses = [];
  let previousDirectText = "";

  for (let index = 0; index < tree.children.length; index += 1) {
    const node = tree.children[index];
    if (node.type === "heading") {
      headings.length = node.depth - 1;
      headings[node.depth - 1] = canonicalText(node);
      previousDirectText = "";
      continue;
    }
    const headingPath = headings.filter(Boolean).join(" / ").normalize("NFC");
    const nextCode =
      tree.children[index + 1]?.type === "code"
        ? tree.children[index + 1]
        : null;
    const extracted = clausesForNode(
      filePath,
      headingPath,
      node,
      previousDirectText,
      nextCode,
    );
    clauses.push(...extracted);
    previousDirectText = extracted.some((clause) => clause.direct)
      ? (extracted.at(-1)?.canonicalText ?? "")
      : "";
  }

  return finalizeClauses(filePath, clauses);
}

function clausesForNode(
  filePath,
  headingPath,
  node,
  previousDirectText,
  nextCode,
) {
  if (node.type === "paragraph") {
    return paragraphClause(filePath, headingPath, node, nextCode);
  }
  if (node.type === "list") {
    return listClauses(headingPath, node, previousDirectText);
  }
  if (node.type === "table") {
    return tableClauses(headingPath, node, previousDirectText);
  }
  return [];
}

function paragraphClause(filePath, headingPath, node, nextCode) {
  let text = canonicalText(node);
  const direct = isNormative(text);
  const fenced = nextCode && !isFenceExcluded(filePath);
  if (!direct && !fenced) return [];
  if (fenced) text = `${text}\n${normalizeCode(nextCode.value)}`;
  return [
    {
      canonicalText: text,
      direct,
      headingPath,
      kind: direct ? "paragraph" : "fenced-contract",
    },
  ];
}

function listClauses(headingPath, list, previousDirectText) {
  const inherited =
    previousDirectText.endsWith(":") ||
    isInheritedListHeading(headingPath, list);
  const clauses = [];
  for (const item of leafListItems(list)) {
    const text = canonicalText({
      ...item,
      children: item.children.filter((child) => child.type !== "list"),
    });
    const direct = isNormative(text);
    if (!direct && !inherited) continue;
    const acceptance =
      list.ordered && headingPath.includes("Product Acceptance Scenarios");
    let kind = "inherited-list-item";
    if (direct) kind = "list-item";
    if (acceptance) kind = "acceptance-step";
    clauses.push({
      canonicalText: text,
      direct,
      headingPath,
      kind,
    });
  }
  return clauses;
}

function tableClauses(headingPath, table, previousDirectText) {
  const inherited = isNormative(previousDirectText);
  return table.children.slice(1).flatMap((row) => {
    const text = row.children.map(canonicalText).join("\u001f");
    const direct = isNormative(text);
    if (!direct && !inherited) return [];
    return [
      {
        canonicalText: text,
        direct,
        headingPath,
        kind: direct ? "table-row" : "inherited-table-row",
      },
    ];
  });
}

function leafListItems(list) {
  const leaves = [];
  for (const item of list.children) {
    const nestedLists = item.children.filter((child) => child.type === "list");
    if (nestedLists.length === 0) leaves.push(item);
    for (const nested of nestedLists) leaves.push(...leafListItems(nested));
  }
  return leaves;
}

function isInheritedListHeading(headingPath, list) {
  if (list.ordered && headingPath.includes("Product Acceptance Scenarios"))
    return true;
  return [
    "Persistence and Fault Tests",
    "Obsidian Host Contract Acceptance",
    "Deliverables",
    "Exit evidence",
  ].some((heading) => headingPath.endsWith(heading));
}

function canonicalText(node) {
  return inlineText(node).normalize("NFC").replace(/\s+/gu, " ").trim();
}

function inlineText(node) {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "link") {
    const label = node.children.map(inlineText).join("");
    return `${label} (${node.url.normalize("NFC")})`;
  }
  if (!Array.isArray(node.children)) return "";
  return node.children.map(inlineText).join(" ");
}

function finalizeClauses(filePath, clauses) {
  const occurrences = new Map();
  return clauses.map((clause) => {
    const key = `${clause.headingPath}\0${clause.kind}\0${clause.canonicalText}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    const input = [
      filePath.normalize("NFC"),
      clause.headingPath,
      clause.kind,
      occurrence,
      clause.canonicalText,
    ].join("\0");
    const fullSha256 = digest(input);
    return {
      id: `REQ-${fullSha256.slice(0, 20)}`,
      path: filePath,
      headingPath: clause.headingPath,
      kind: clause.kind,
      occurrence,
      fullSha256,
      canonicalTextSha256: digest(clause.canonicalText),
    };
  });
}

function isNormative(text) {
  return /\b(?:MUST|MUST NOT|SHALL|SHALL NOT|SHOULD|SHOULD NOT)\b/u.test(text);
}

function isFenceExcluded(filePath) {
  return /\/(?:12-toolbar-mockup|13-references)\.md$/u.test(filePath);
}

function normalizeCode(value) {
  return value.replace(/\r\n?/gu, "\n");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
