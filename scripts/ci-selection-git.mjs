import { execFile, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const codeFile = /\.(?:[cm]?[jt]s|[jt]sx)$/;
export const testFile = /^test\/(?:unit|integration|performance)\/.+\.test\.(?:ts|tsx|mjs)$/;

async function git(root, args) {
  const result = await execute("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  return result.stdout;
}

function changedPaths(output) {
  const tokens = output.split("\0");
  const paths = new Set();
  for (let index = 0; index < tokens.length - 1;) {
    const status = tokens[index++];
    const count = /^[RC]/.test(status) ? 2 : 1;
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) throw new Error("Invalid Git change status");
    for (let entry = 0; entry < count; entry++) {
      const value = tokens[index++];
      if (!value) throw new Error("Incomplete Git changes");
      paths.add(value);
    }
  }
  return [...paths].sort();
}

export async function inspectChanges({ root, base, head = "HEAD" }) {
  if (typeof base !== "string" || !base) throw new Error("Missing comparison base");
  const resolvedHead = (
    await git(root, ["rev-parse", "--verify", "--end-of-options", `${head}^{commit}`])
  ).trim();
  const resolvedBase = (
    await git(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`])
  ).trim();
  const mergeBase = (await git(root, ["merge-base", resolvedBase, resolvedHead])).trim();
  if (!/^[a-f0-9]{40,64}$/.test(mergeBase)) throw new Error("Missing merge base");
  const output = await git(root, [
    "diff",
    "--no-ext-diff",
    "--name-status",
    "-z",
    "--find-renames",
    mergeBase,
    resolvedHead,
    "--",
  ]);
  return { base: mergeBase, head: resolvedHead, changes: changedPaths(output) };
}

async function collectFiles(root, directory, files) {
  let entries;
  try {
    entries = await readdir(path.join(root, directory), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const filename = path.posix.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unsupported graph symlink: ${filename}`);
    if (entry.isDirectory()) await collectFiles(root, filename, files);
    else if (entry.isFile() && codeFile.test(filename)) files.push(filename);
  }
}

export async function readHeadFiles(root) {
  const filenames = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && codeFile.test(entry.name))
    .map((entry) => entry.name);
  for (const directory of ["src", "test", "scripts"]) {
    await collectFiles(root, directory, filenames);
  }
  return new Map(
    await Promise.all(
      filenames.sort().map(async (file) => [file, await readFile(path.join(root, file), "utf8")]),
    ),
  );
}

function readBlobs(root, ids) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let bytes = 0;
    const timeout = setNodeTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      clearNodeTimeout(timeout);
      if (code !== 0 || bytes > 64 * 1024 * 1024) reject(new Error("Cannot read base graph blobs"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.on("error", reject);
    child.stdin.end(ids.join("\n") + "\n");
  });
}

export async function readBaseFiles(root, revision) {
  const tree = await git(root, ["ls-tree", "-rz", "--full-tree", revision]);
  const entries = tree
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("\t");
      return { metadata: entry.slice(0, separator).split(" "), file: entry.slice(separator + 1) };
    })
    .filter(
      ({ file }) =>
        codeFile.test(file) && (!file.includes("/") || /^(?:src|test|scripts)\//.test(file)),
    );
  if (!entries.length) return new Map();
  if (entries.some(({ metadata }) => metadata[0] === "120000"))
    throw new Error("Unsupported base graph symlink");
  const output = await readBlobs(
    root,
    entries.map(({ metadata }) => metadata[2]),
  );
  const files = new Map();
  let offset = 0;
  for (const { file } of entries) {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString("utf8").split(" ");
    const size = Number(header[2]);
    if (end < 0 || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("Invalid base graph blob");
    }
    offset = end + 1;
    files.set(file, output.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  if (offset !== output.length) throw new Error("Incomplete base graph");
  return files;
}
