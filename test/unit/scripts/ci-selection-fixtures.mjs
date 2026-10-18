import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const directories = [];

export async function cleanupRepositories() {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

export async function git(root, ...args) {
  return (await execute("git", args, { cwd: root, encoding: "utf8" })).stdout.trim();
}

export async function write(root, files) {
  for (const [filename, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await writeFile(path.join(root, filename), content);
  }
}

export async function commit(root, files = {}) {
  await write(root, files);
  await git(root, "add", "--all");
  await git(
    root,
    "-c",
    "user.name=CI Test",
    "-c",
    "user.email=ci@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "test: fixture",
  );
  return git(root, "rev-parse", "HEAD");
}

export async function createRepository(files) {
  const root = await mkdtemp(path.join(tmpdir(), "inkbook-ci-selection-"));
  directories.push(root);
  await git(root, "init", "--quiet", "--initial-branch=main");
  const base = await commit(root, files);
  return { root, base };
}
