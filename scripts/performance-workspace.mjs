import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const EXCLUDED = new Set([".git", "src", "node_modules", "dist", "coverage"]);
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function validatePath(file) {
  if (
    typeof file !== "string" ||
    !file ||
    isAbsolute(file) ||
    file.split(/[\\/]/).some((part) => part === ".." || !part)
  ) {
    throw new Error(`Unsafe workspace path: ${file}.`);
  }
}

async function regularFile(root, file) {
  validatePath(file);
  const parts = file.split("/");
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Workspace symlink is not allowed: ${file}.`);
    if (path === join(root, file)) return stat.isFile();
    if (!stat.isDirectory()) return false;
  }
  return false;
}

async function listSourceFiles(root, directory = "src") {
  const files = [];
  const directoryStat = await lstat(join(root, directory));
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    throw new Error(`Invalid source directory: ${directory}.`);
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  for (const entry of entries) {
    const file = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Source symlink is not allowed: ${file}.`);
    if (entry.isDirectory()) files.push(...(await listSourceFiles(root, file)));
    else if (entry.isFile()) files.push(file);
    else throw new Error(`Unsupported source entry: ${file}.`);
  }
  return files.sort();
}

export async function hashWorkspaceFiles(root, files) {
  const hash = createHash("sha256");
  const sorted = [...files].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error("Duplicate workspace hash path.");
  for (const file of sorted) {
    if (!(await regularFile(root, file)))
      throw new Error(`Missing regular workspace file: ${file}.`);
    const digest = createHash("sha256")
      .update(await readFile(join(root, file)))
      .digest("hex");
    hash.update(JSON.stringify([file, digest]) + "\n");
  }
  return hash.digest("hex");
}

export async function hashSourceTree(root) {
  return hashWorkspaceFiles(root, await listSourceFiles(root));
}

async function harnessFiles(root) {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const files = [];
  for (const file of output.split("\0").filter(Boolean)) {
    validatePath(file);
    if (!EXCLUDED.has(file.split("/")[0]) && (await regularFile(root, file))) files.push(file);
  }
  return [...new Set(files)].sort();
}

function resolveCommit(root, ref) {
  if (typeof ref !== "string" || !ref || ref.startsWith("-"))
    throw new Error("Invalid performance source reference.");
  try {
    const commit = git(root, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected a full commit SHA.");
    return commit;
  } catch (error) {
    throw new Error(`Comparable dependencies not verified: missing source reference ${ref}.`, {
      cause: error,
    });
  }
}

export function resolveLocalBaseline(root, fallback) {
  const refs = git(root, "for-each-ref", "--format=%(refname)", "refs/tags/performance-baseline");
  return refs.split("\n").includes("refs/tags/performance-baseline")
    ? resolveCommit(root, "refs/tags/performance-baseline")
    : fallback;
}

function normalizedDependencies(manifest) {
  return JSON.stringify(
    DEPENDENCY_FIELDS.map((field) => [
      field,
      Object.entries(manifest[field] ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ]),
  );
}

async function verifyDependencies(root, commits) {
  const lock = await readFile(join(root, "package-lock.json"), "utf8");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  for (const commit of new Set(commits)) {
    try {
      const oldLock = execFileSync("git", ["show", `${commit}:package-lock.json`], {
        cwd: root,
        encoding: "utf8",
      });
      const oldManifest = JSON.parse(git(root, "show", `${commit}:package.json`));
      if (
        oldLock !== lock ||
        normalizedDependencies(oldManifest) !== normalizedDependencies(manifest)
      ) {
        throw new Error("Dependency manifest or lockfile differs.");
      }
    } catch (error) {
      throw new Error(`Comparable dependencies not verified for ${commit}: ${error.message}`, {
        cause: error,
      });
    }
  }
  return createHash("sha256").update(lock).digest("hex");
}

async function copyFiles(source, destination, files) {
  for (const file of files) {
    if (!(await regularFile(source, file))) throw new Error(`Workspace file disappeared: ${file}.`);
    await mkdir(dirname(join(destination, file)), { recursive: true });
    await copyFile(join(source, file), join(destination, file));
  }
}

async function createWorkspace(context, variant, sourceCommit) {
  const root = join(context.temporary, variant);
  await mkdir(root);
  await copyFiles(context.projectRoot, root, context.files);
  if ((await hashWorkspaceFiles(root, context.files)) !== context.harnessHash)
    throw new Error("Harness changed during workspace preparation.");
  if (variant === "candidate") {
    await copyFiles(context.projectRoot, root, await listSourceFiles(context.projectRoot));
  } else {
    const archive = join(context.temporary, `${variant}-source.tar`);
    execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, sourceCommit, "src"], {
      cwd: context.projectRoot,
    });
    execFileSync("tar", ["-xf", archive, "-C", root]);
    await rm(archive);
  }
  const sourceHash = await hashSourceTree(root);
  await symlink(join(context.projectRoot, "node_modules"), join(root, "node_modules"), "dir");
  return { root, sourceHash, sourceCommit };
}

export async function preparePerformanceWorkspaces(projectRoot, refs) {
  projectRoot = resolve(projectRoot);
  const harnessCommit = resolveCommit(projectRoot, "HEAD");
  const baseCommit = resolveCommit(projectRoot, refs.base);
  const anchorCommit = resolveCommit(projectRoot, refs.anchor);
  const lockSha256 = await verifyDependencies(projectRoot, [baseCommit, anchorCommit]);
  const files = await harnessFiles(projectRoot);
  const harnessHash = await hashWorkspaceFiles(projectRoot, files);
  const temporary = await mkdtemp(join(tmpdir(), "inkbook-performance-workspaces-"));
  const dispose = () => rm(temporary, { recursive: true, force: true });
  try {
    const context = { projectRoot, temporary, files, harnessHash };
    const candidate = await createWorkspace(context, "candidate", harnessCommit);
    const base = await createWorkspace(context, "base", baseCommit);
    const anchor =
      baseCommit === anchorCommit ? base : await createWorkspace(context, "anchor", anchorCommit);
    return {
      candidate,
      base,
      anchor,
      dispose,
      metadata: {
        projectRoot,
        harnessCommit,
        testedTree: git(projectRoot, "rev-parse", "HEAD^{tree}"),
        baseCommit,
        anchorCommit,
        candidateSourceHash: candidate.sourceHash,
        anchorSourceHash: anchor.sourceHash,
        harnessHash,
        lockSha256,
        dirty: git(projectRoot, "status", "--porcelain").length > 0,
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
