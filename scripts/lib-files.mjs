import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "coverage",
  "node_modules",
  "playwright-report",
  "test-results",
]);

export async function listFiles(root = ".") {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const entryPath = path.posix.join(root === "." ? "" : root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(entryPath)));
    if (entry.isFile()) files.push(entryPath);
  }

  return files.sort();
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function fail(message) {
  throw new Error(message);
}
