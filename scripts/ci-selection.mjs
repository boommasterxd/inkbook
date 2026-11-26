import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  codeFile,
  checkoutRevision,
  inspectChanges,
  readBaseFiles,
  readHeadFiles,
  testFile,
} from "./ci-selection-git.mjs";
import { affectedFiles, createGraph } from "./ci-selection-graph.mjs";

export { inspectChanges } from "./ci-selection-git.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const planKeys = [
  "base",
  "changes",
  "head",
  "merge",
  "mergeBase",
  "mode",
  "reason",
  "tests",
  "version",
];
const revision = (value) => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
const documentationPath = (value) => value.startsWith("docs/") && value.endsWith(".md");
const safePath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !/[\0\r\n]/.test(value) &&
  value.split("/").every((part) => part !== ".." && part !== "." && part !== "");

function sortedPaths(values, predicate = () => true) {
  return (
    Array.isArray(values) &&
    values.every(
      (value, index) =>
        safePath(value) && predicate(value) && (index === 0 || values[index - 1] < value),
    )
  );
}

function validShape(plan) {
  return (
    Object.keys(plan).sort().join() === planKeys.join() &&
    plan.version === 3 &&
    ["docs", "full", "affected", "no-impact"].includes(plan.mode) &&
    typeof plan.reason === "string" &&
    plan.reason.trim().length > 0 &&
    typeof plan.head === "string" &&
    plan.head.length > 0 &&
    (plan.base === null || revision(plan.base)) &&
    revision(plan.merge) &&
    (plan.mergeBase === null || revision(plan.mergeBase)) &&
    sortedPaths(plan.changes) &&
    sortedPaths(plan.tests, (file) => testFile.test(file))
  );
}

export function validateSelection(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan))
    throw new Error("Invalid CI selection object");
  if (!validShape(plan)) throw new Error("Invalid CI selection shape");
  if (plan.mode === "docs" && !plan.changes.every(documentationPath))
    throw new Error("Invalid documentation selection");
  if (
    plan.mode !== "full" &&
    (!plan.base || !plan.mergeBase || !revision(plan.head) || !plan.changes.length)
  )
    throw new Error("Incomplete CI revision binding");
  const expectsTests = plan.mode === "affected" || plan.mode === "full";
  const hasTests = plan.tests.length > 0;
  if (expectsTests !== hasTests) throw new Error("Invalid CI test selection.");
  return plan;
}

function globalChange(filename) {
  if (documentationPath(filename) || ["AGENTS.md", "README.md"].includes(filename)) return false;
  if (/^test\/(?:setup|global-setup)(?:[./-]|$)/.test(filename)) return true;
  if ([".github/workflows/ci.yml", ".github/workflows/release.yml"].includes(filename)) return true;
  if (/^scripts\/(?:build|verify-package)/.test(filename)) return true;
  if (
    /^scripts\/(?:ci-[\w-]+|check-command-plan|check-execution|run-checks|run-ci|run-validated-tests|performance-[\w-]+|run-performance-tests)\.mjs$/.test(
      filename,
    )
  )
    return true;
  if (filename.startsWith("scripts/") && !codeFile.test(filename)) return true;
  return !(
    filename.startsWith("src/") ||
    filename.startsWith("test/") ||
    filename.startsWith("scripts/") ||
    filename.startsWith(".github/workflows/")
  );
}

function mappedTests(changes, tests) {
  const mapped = new Set();
  for (const filename of changes) {
    if (filename.startsWith("docs/")) continue;
    if (
      filename.endsWith(".css") ||
      (!codeFile.test(filename) && /^(?:src|test)\//.test(filename))
    ) {
      for (const test of tests) mapped.add(test);
    }
    if (filename.startsWith(".github/workflows/")) {
      for (const test of tests.filter((file) =>
        /^test\/unit\/scripts\/.+workflow.*\.test\.mjs$/.test(file),
      ))
        mapped.add(test);
    }
    if (filename.startsWith("scripts/")) {
      for (const test of tests.filter((file) => file.startsWith("test/unit/scripts/")))
        mapped.add(test);
    }
  }
  return mapped;
}

function graphSelection(graphs, changes, tests) {
  const affected = affectedFiles(graphs, changes);
  const selected = mappedTests(changes, tests);
  for (const test of tests) if (affected.has(test)) selected.add(test);
  if (changes.some((file) => testFile.test(file) && !selected.has(file))) {
    throw new Error("A changed test was removed or renamed.");
  }
  return [...selected].sort();
}

async function comparisonState(root, base, head, merge) {
  const fallback = {
    base: null,
    head,
    merge: await checkoutRevision(root, merge),
    mergeBase: null,
    changes: [],
  };
  try {
    return { comparison: await inspectChanges({ root, base, head, merge: fallback.merge }) };
  } catch (error) {
    if (error.code === "CI_REVISION_MISMATCH") throw error;
    return {
      comparison: fallback,
      historyError: `Unavailable comparison history: ${error.message}`,
    };
  }
}

export async function createSelection({
  root = projectRoot,
  base,
  head = "HEAD",
  merge,
  forceFull = false,
} = {}) {
  root = path.resolve(root);
  const { comparison, historyError } = await comparisonState(root, base, head, merge);
  const plan = {
    version: 3,
    mode: "full",
    reason: "Full verification requested",
    ...comparison,
    tests: [],
  };
  if (
    !forceFull &&
    !historyError &&
    comparison.changes.length &&
    comparison.changes.every(documentationPath)
  ) {
    return validateSelection({ ...plan, mode: "docs", reason: "Only root docs/ content changed" });
  }
  const files = await readHeadFiles(root);
  const tests = [...files.keys()].filter((file) => testFile.test(file)).sort();
  plan.tests = tests;
  validateSelection(plan);
  const global = comparison.changes.find(globalChange);
  if (forceFull || historyError || !comparison.changes.length || global) {
    plan.reason =
      historyError ??
      (forceFull
        ? plan.reason
        : global
          ? `Global or unknown change: ${global}`
          : "Empty comparison diff");
    return validateSelection(plan);
  }
  try {
    const ts = (await import("typescript")).default;
    const baseFiles = await readBaseFiles(root, comparison.mergeBase);
    const graphs = [createGraph(ts, root, files), createGraph(ts, root, baseFiles)];
    const selected = graphSelection(graphs, comparison.changes, tests);
    return validateSelection({
      ...plan,
      mode: selected.length ? "affected" : "no-impact",
      reason: selected.length
        ? "Tests selected from both dependency graphs and explicit mappings"
        : "Neither dependency graph nor explicit mappings identify an affected test",
      tests: selected,
    });
  } catch (error) {
    return validateSelection({ ...plan, reason: `Conservative fallback: ${error.message}` });
  }
}
