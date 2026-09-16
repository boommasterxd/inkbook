import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  hashSourceTree,
  hashWorkspaceFiles,
  preparePerformanceWorkspaces,
  resolveLocalBaseline,
} from "../../../scripts/performance-workspace.mjs";

const cleanup = [];
const git = (root, ...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkbook-workspace-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workspace Test");
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, ".gitignore"), "node_modules/\ndist/\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { example: "1.0.0" }, scripts: { test: "old" } }),
  );
  await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  await writeFile(join(root, "src/main.ts"), "export const value = 1;\n");
  await writeFile(join(root, "harness.mjs"), "old harness\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "test: add fixture");
  return { root, commit: git(root, "rev-parse", "HEAD") };
}

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("performance workspace snapshots", () => {
  it("uses the bootstrap only until a local baseline tag exists", async () => {
    const { root, commit } = await fixture();
    expect(resolveLocalBaseline(root, "bootstrap")).toBe("bootstrap");
    git(root, "tag", "performance-baseline-audit-example", commit);
    expect(resolveLocalBaseline(root, "bootstrap")).toBe("bootstrap");
    git(root, "tag", "performance-baseline", commit);
    expect(resolveLocalBaseline(root, "bootstrap")).toBe(commit);
  });
  it("uses current identical harness with old source and keeps dirty candidate changes", async () => {
    const { root, commit } = await fixture();
    await writeFile(join(root, "harness.mjs"), "new harness\n");
    await writeFile(join(root, "new-harness.mjs"), "untracked harness\n");
    await writeFile(join(root, "src/main.ts"), "export const value = 2;\n");
    await writeFile(join(root, "src/new.ts"), "new source\n");
    const packageFile = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    packageFile.scripts.test = "new";
    await writeFile(join(root, "package.json"), JSON.stringify(packageFile));
    const workspaces = await preparePerformanceWorkspaces(root, { base: commit, anchor: commit });
    cleanup.push(workspaces.dispose);
    expect(workspaces.base).toBe(workspaces.anchor);
    expect(workspaces.candidate.root).not.toBe(workspaces.base.root);
    expect(await readFile(join(workspaces.base.root, "src/main.ts"), "utf8")).toContain("= 1");
    expect(await readFile(join(workspaces.candidate.root, "src/main.ts"), "utf8")).toContain("= 2");
    await expect(access(join(workspaces.base.root, "src/new.ts"))).rejects.toThrow();
    for (const variant of [workspaces.base, workspaces.candidate]) {
      expect(await readFile(join(variant.root, "harness.mjs"), "utf8")).toBe("new harness\n");
      expect(await readFile(join(variant.root, "new-harness.mjs"), "utf8")).toBe(
        "untracked harness\n",
      );
      expect(variant.sourceHash).toBe(await hashSourceTree(variant.root));
      await expect(access(join(variant.root, "node_modules"))).resolves.toBeUndefined();
    }
    expect(workspaces.metadata.dirty).toBe(true);
    expect(workspaces.metadata.harnessCommit).toBe(commit);
    expect(workspaces.candidate.sourceHash).not.toBe(workspaces.base.sourceHash);
    await workspaces.dispose();
    await expect(access(workspaces.candidate.root)).rejects.toThrow();
    await expect(access(root)).resolves.toBeUndefined();
  });

  it("creates separate workspaces for distinct source commits", async () => {
    const { root, commit } = await fixture();
    await writeFile(join(root, "src/main.ts"), "export const value = 2;\n");
    git(root, "add", "src");
    git(root, "commit", "-qm", "test: update source");
    const workspaces = await preparePerformanceWorkspaces(root, { base: "HEAD", anchor: commit });
    cleanup.push(workspaces.dispose);
    expect(workspaces.anchor.root).not.toBe(workspaces.base.root);
    expect(workspaces.base.sourceHash).toBe(workspaces.candidate.sourceHash);
    expect(workspaces.metadata.dirty).toBe(false);
  });

  it.each(["package-lock.json", "package.json"])(
    "fails closed when %s dependencies differ",
    async (file) => {
      const { root, commit } = await fixture();
      await writeFile(join(root, file), JSON.stringify({ dependencies: { example: "2.0.0" } }));
      await expect(
        preparePerformanceWorkspaces(root, { base: commit, anchor: commit }),
      ).rejects.toThrow("Comparable dependencies not verified");
    },
  );

  it("rejects missing references", async () => {
    const { root, commit } = await fixture();
    await expect(
      preparePerformanceWorkspaces(root, { base: "missing-ref", anchor: commit }),
    ).rejects.toThrow("missing source reference");
  });

  it("never reads harness or source symlink targets and cleans failed preparation", async () => {
    const { root, commit } = await fixture();
    await symlink("/etc/passwd", join(root, "foreign-link"));
    await expect(
      preparePerformanceWorkspaces(root, { base: commit, anchor: commit }),
    ).rejects.toThrow("symlink");
    await rm(join(root, "foreign-link"));
    await symlink("/etc/passwd", join(root, "src/foreign-link"));
    const before = (await readdir(tmpdir()))
      .filter((name) => name.startsWith("inkbook-performance-workspaces-"))
      .sort();
    await expect(
      preparePerformanceWorkspaces(root, { base: commit, anchor: commit }),
    ).rejects.toThrow("symlink");
    expect(
      (await readdir(tmpdir()))
        .filter((name) => name.startsWith("inkbook-performance-workspaces-"))
        .sort(),
    ).toEqual(before);
  });
});

describe("workspace content hashes", () => {
  it("is order independent but detects file names and bytes", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "src/other.ts"), "other\n");
    const files = ["src/main.ts", "src/other.ts"];
    const hash = await hashWorkspaceFiles(root, files);
    expect(await hashWorkspaceFiles(root, [...files].reverse())).toBe(hash);
    await writeFile(join(root, "src/other.ts"), "changed\n");
    expect(await hashWorkspaceFiles(root, files)).not.toBe(hash);
    await expect(hashWorkspaceFiles(root, ["../secret"])).rejects.toThrow("Unsafe");
    await expect(hashWorkspaceFiles(root, [files[0], files[0]])).rejects.toThrow("Duplicate");
    await expect(hashWorkspaceFiles(root, ["missing"])).rejects.toThrow("Missing");
  });
});
