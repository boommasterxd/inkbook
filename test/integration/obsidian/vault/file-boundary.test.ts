import type { FileManager, TFile, TFolder, Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { VaultBoundaryError } from "../../../../src/obsidian/vault/boundary";
import { ObsidianVaultFileAdapter } from "../../../../src/obsidian/vault/file-adapter";
import { ObsidianVaultFolderAdapter } from "../../../../src/obsidian/vault/folder-adapter";
import { ObsidianManagedFileAdapter } from "../../../../src/obsidian/vault/managed-files";
import { ObsidianCreationPathResolver } from "../../../../src/obsidian/vault/placement";

class FakeFile {
  basename: string;
  extension: string;
  name: string;
  parent: FakeFolder | null = null;
  path: string;
  stat: { ctime: number; mtime: number; size: number };

  constructor(path: string, size = 0) {
    this.path = path;
    this.name = path.slice(path.lastIndexOf("/") + 1);
    this.extension = this.name.slice(this.name.lastIndexOf(".") + 1);
    this.basename = this.name.slice(0, -(this.extension.length + 1));
    this.stat = { ctime: 0, mtime: 0, size };
  }
}

class FakeFolder {
  children: (FakeFile | FakeFolder)[] = [];
  name: string;
  parent: FakeFolder | null = null;
  path: string;

  constructor(path: string) {
    this.path = path;
    this.name = path.slice(path.lastIndexOf("/") + 1);
  }

  isRoot(): boolean {
    return this.path === "";
  }
}

interface FakeVaultState {
  readonly binary: Map<string, ArrayBuffer>;
  readonly binaryReads: string[];
  readonly files: Map<string, FakeFile>;
  readonly folders: Map<string, FakeFolder>;
  onTextRead: ((file: FakeFile) => void) | null;
  processCalls: number;
  readonly text: Map<string, string>;
  textReadGate: Promise<void> | null;
  readonly textReads: string[];
}

function createVault(): { readonly state: FakeVaultState; readonly vault: Vault } {
  const root = new FakeFolder("");
  const state: FakeVaultState = {
    binary: new Map(),
    binaryReads: [],
    files: new Map(),
    folders: new Map([["", root]]),
    onTextRead: null,
    processCalls: 0,
    text: new Map(),
    textReadGate: null,
    textReads: [],
  };
  const vault = {
    cachedRead: async (file: FakeFile) => state.text.get(file.path)!,
    create: async (path: string, content: string) => {
      const file = new FakeFile(path, content.length);
      state.files.set(path, file);
      state.text.set(path, content);
      return file;
    },
    createFolder: async (path: string) => {
      state.folders.set(path, new FakeFolder(path));
    },
    getAbstractFileByPath: (path: string) =>
      state.files.get(path) ?? state.folders.get(path) ?? null,
    getFileByPath: (path: string) => state.files.get(path) ?? null,
    getFolderByPath: (path: string) => state.folders.get(path) ?? null,
    getRoot: () => root,
    process: async (file: FakeFile, update: (current: string) => string) => {
      state.processCalls += 1;
      const result = update(state.text.get(file.path)!);
      state.text.set(file.path, result);
      file.stat.size = new TextEncoder().encode(result).byteLength;
      return result;
    },
    read: async (file: FakeFile) => {
      state.textReads.push(file.path);
      state.onTextRead?.(file);
      if (state.textReadGate !== null) await state.textReadGate;
      return state.text.get(file.path)!;
    },
    readBinary: async (file: FakeFile) => {
      state.binaryReads.push(file.path);
      return (
        state.binary.get(file.path) ?? new TextEncoder().encode(state.text.get(file.path)).buffer
      );
    },
  };
  return { state, vault: vault as unknown as Vault };
}

function resolveCreationPath(
  fileManager: FileManager,
  files: ObsidianVaultFileAdapter,
  placement: Parameters<ObsidianCreationPathResolver["resolve"]>[0],
  fillByte: number,
) {
  const resolver = new ObsidianCreationPathResolver(fileManager, files, (path) => path);
  return resolver.resolve(placement, "notes/note.md", new Date(2026, 0, 2, 3, 4, 5), {
    fill: (bytes) => bytes.fill(fillByte),
  });
}

function resolveAttachmentCollision(
  vault: Vault,
  getAvailablePathForAttachment: (name: string) => Promise<string>,
) {
  const files = new ObsidianVaultFileAdapter(vault, classes, (path) => path);
  let randomByte = 0;
  const resolver = new ObsidianCreationPathResolver(
    { getAvailablePathForAttachment } as unknown as FileManager,
    files,
    (path) => path,
  );
  return resolver.resolve(
    { mode: "obsidian-attachment-folder" },
    "notes/note.md",
    new Date(2026, 0, 2, 3, 4, 5),
    { fill: (bytes) => bytes.fill(++randomByte) },
  );
}

const classes = {
  file: FakeFile as unknown as abstract new (...arguments_: never[]) => TFile,
  folder: FakeFolder as unknown as abstract new (...arguments_: never[]) => TFolder,
};

function createBinaryReadFixture(path: string, declaredSize: number) {
  const { state, vault } = createVault();
  const file = new FakeFile(path, declaredSize);
  state.files.set(file.path, file);
  state.text.set(file.path, "hello world");
  const files = new ObsidianVaultFileAdapter(vault, classes, (candidate) => candidate);
  return { file, files, state };
}

describe("Obsidian vault file boundary", () => {
  it("rejects unsafe paths before calling the host normalizer", () => {
    const { vault } = createVault();
    const normalize = vi.fn((path: string) => path);
    const files = new ObsidianVaultFileAdapter(vault, classes, normalize);

    expect(() => files.resolveFile("../outside.svg")).toThrow(VaultBoundaryError);
    expect(normalize).not.toHaveBeenCalled();
  });

  it("requires concrete file and folder instances", () => {
    const { state, vault } = createVault();
    state.folders.set("drawings", new FakeFolder("drawings"));
    const files = new ObsidianVaultFileAdapter(vault, classes, (path) => path);

    expect(files.resolveFolder("drawings").path).toBe("drawings");
    expect(() => files.resolveFile("drawings")).toThrow(VaultBoundaryError);
    expect(() => files.resolveFolder("missing")).toThrow(VaultBoundaryError);
  });
});

describe("Obsidian vault bounded reads", () => {
  it("preflights file size before reading binary content", async () => {
    const { file, files, state } = createBinaryReadFixture("drawings/large.svg", 11);

    await expect(files.readBinaryForUnlock(file.path, 10)).rejects.toMatchObject({
      code: "file-too-large",
    });
    expect(state.binaryReads).toEqual([]);
    await expect(files.readBinaryForUnlock(file.path, 11)).resolves.toMatchObject({
      path: file.path,
      size: 11,
    });
    expect(state.binaryReads).toEqual([file.path]);
  });

  it("rejects a returned binary that exceeds the limit after a stale size preflight", async () => {
    const { file, files, state } = createBinaryReadFixture("drawings/raced.svg", 1);

    await expect(files.readBinaryForUnlock(file.path, 10)).rejects.toMatchObject({
      code: "file-too-large",
    });
    expect(state.binaryReads).toEqual([file.path]);
  });

  it.each([
    ["shorter", "short"],
    ["longer", "hello world!"],
  ])(
    "rejects %s binary content when stable metadata reports another size",
    async (_label, content) => {
      const { file, files, state } = createBinaryReadFixture("drawings/raced.svg", 11);
      state.binary.set(file.path, new TextEncoder().encode(content).buffer);

      await expect(files.readBinaryForUnlock(file.path, 12)).rejects.toMatchObject({
        code: "unexpected-host-result",
      });
      expect(file.stat).toEqual({ ctime: 0, mtime: 0, size: 11 });
    },
  );

  it("rejects oversized text returned after a stale size preflight", async () => {
    const { file, files, state } = createBinaryReadFixture("drawings/raced.svg", 1);

    await expect(files.readWithMetadataGuard(file.path, 10)).rejects.toMatchObject({
      code: "file-too-large",
    });
    expect(state.textReads).toEqual([file.path]);
  });

  it("rejects known oversized text before calling the host read", async () => {
    const { file, files, state } = createBinaryReadFixture("drawings/large-text.svg", 12);

    await expect(files.readWithMetadataGuard(file.path, 11)).rejects.toMatchObject({
      code: "file-too-large",
    });
    expect(state.textReads).toEqual([]);
  });

  it("fails closed when file metadata changes during a text read", async () => {
    const { file, files, state } = createBinaryReadFixture("drawings/changed.svg", 11);
    state.onTextRead = (target) => {
      target.stat.size += 1;
    };

    await expect(files.readWithMetadataGuard(file.path, 11)).rejects.toMatchObject({
      code: "unexpected-host-result",
    });
  });

  it("fails closed when the path resolves to a replacement file after reading", async () => {
    const { file, files, state } = createBinaryReadFixture("drawings/replaced.svg", 11);
    state.onTextRead = (target) => {
      state.files.set(target.path, new FakeFile(target.path, target.stat.size));
    };

    await expect(files.readWithMetadataGuard(file.path, 11)).rejects.toMatchObject({
      code: "unexpected-host-result",
    });
  });

  it("serializes bounded reads and process writes for the same path", async () => {
    const { file, files, state } = createBinaryReadFixture("drawings/serialized.svg", 11);
    let releaseRead: (() => void) | undefined;
    state.textReadGate = new Promise((resolve) => {
      releaseRead = resolve;
    });

    const read = files.readWithMetadataGuard(file.path, 11);
    await vi.waitFor(() => expect(state.textReads).toEqual([file.path]));
    const write = files.process(file.path, (current) => `${current}!`);
    await Promise.resolve();
    expect(state.processCalls).toBe(0);

    releaseRead?.();
    await expect(read).resolves.toMatchObject({ content: "hello world" });
    await expect(write).resolves.toBe("hello world!");
    expect(state.processCalls).toBe(1);
  });
});

describe("Obsidian vault verified creation", () => {
  it("keeps creation and its guarded read-back in one serialized path operation", async () => {
    const { files, state } = createBinaryReadFixture("drawings/existing.svg", 11);
    let releaseRead: (() => void) | undefined;
    state.textReadGate = new Promise((resolve) => {
      releaseRead = resolve;
    });

    const creation = files.createAndReadBack("drawings/new.svg", "new-content", 11);
    await vi.waitFor(() => expect(state.textReads).toEqual(["drawings/new.svg"]));
    const write = files.process("drawings/new.svg", (current) => `${current}!`);
    await Promise.resolve();
    expect(state.processCalls).toBe(0);

    releaseRead?.();
    await expect(creation).resolves.toMatchObject({ content: "new-content" });
    await expect(write).resolves.toBe("new-content!");
  });
});

describe("Obsidian vault basic operations", () => {
  it("adapts create, uncached read, cached read, and synchronous process", async () => {
    const { state, vault } = createVault();
    const files = new ObsidianVaultFileAdapter(vault, classes, (path) => path);

    await files.create("drawings/new.svg", "old");
    expect(await files.size("drawings/new.svg")).toBe(3);
    expect(await files.read("drawings/new.svg")).toBe("old");
    expect(await files.cachedRead("drawings/new.svg")).toBe("old");
    expect(await files.process("drawings/new.svg", (current) => `${current}-new`)).toBe("old-new");
    expect(state.text.get("drawings/new.svg")).toBe("old-new");
  });
});

describe("Obsidian creation placement and managed files", () => {
  it("creates and verifies a custom folder through the public Vault API", async () => {
    const { state, vault } = createVault();
    const folders = new ObsidianVaultFolderAdapter(vault, classes.folder, (path) => path);

    await folders.createFolder("drawings/inkbook");
    await folders.createFolder("drawings/inkbook");

    expect(state.folders.get("drawings/inkbook")).toBeInstanceOf(FakeFolder);
  });

  it("uses the public attachment path resolver", async () => {
    const { vault } = createVault();
    const files = new ObsidianVaultFileAdapter(vault, classes, (path) => path);
    const getAvailablePathForAttachment = vi.fn(async (name: string) => `assets/${name}`);
    const result = await resolveCreationPath(
      { getAvailablePathForAttachment } as unknown as FileManager,
      files,
      { mode: "obsidian-attachment-folder" },
      1,
    );

    expect(result).toEqual({
      fallback: null,
      path: "assets/inkbook-20260102-030405-010101.svg",
    });
    expect(getAvailablePathForAttachment).toHaveBeenCalledWith(
      "inkbook-20260102-030405-010101.svg",
      "notes/note.md",
    );
  });
});

describe("Obsidian attachment placement collisions", () => {
  it("retries with fresh random hex when the attachment API reports a collision", async () => {
    const { vault } = createVault();
    let request = 0;
    const getAvailablePathForAttachment = vi.fn(async (name: string) =>
      ++request === 1 ? `assets/${name.replace(/\.svg$/u, " 1.svg")}` : `assets/${name}`,
    );

    const result = await resolveAttachmentCollision(vault, getAvailablePathForAttachment);

    expect(result.path).toBe("assets/inkbook-20260102-030405-020202.svg");
    expect(result.path).toMatch(/inkbook-\d{8}-\d{6}-[0-9a-f]{6}\.svg$/u);
    expect(getAvailablePathForAttachment).toHaveBeenCalledTimes(2);
  });

  it("retries when an unchanged attachment API result already exists in the Vault", async () => {
    const { state, vault } = createVault();
    state.files.set(
      "assets/inkbook-20260102-030405-010101.svg",
      new FakeFile("assets/inkbook-20260102-030405-010101.svg"),
    );
    const getAvailablePathForAttachment = vi.fn(async (name: string) => `assets/${name}`);

    const result = await resolveAttachmentCollision(vault, getAvailablePathForAttachment);

    expect(result.path).toBe("assets/inkbook-20260102-030405-020202.svg");
    expect(getAvailablePathForAttachment).toHaveBeenCalledTimes(2);
  });
});

describe("Obsidian creation fallback and managed files", () => {
  it("falls back from an unavailable custom folder to the note folder", async () => {
    const { state, vault } = createVault();
    state.folders.set("notes", new FakeFolder("notes"));
    const files = new ObsidianVaultFileAdapter(vault, classes, (path) => path);
    const result = await resolveCreationPath(
      {} as FileManager,
      files,
      { mode: "custom-vault-folder", folder: "missing" },
      2,
    );

    expect(result).toEqual({
      fallback: "custom-folder-unavailable",
      path: "notes/inkbook-20260102-030405-020202.svg",
    });
  });

  it("falls back when Obsidian cannot resolve an attachment path", async () => {
    const { vault } = createVault();
    const files = new ObsidianVaultFileAdapter(vault, classes, (path) => path);
    const result = await resolveCreationPath(
      {
        getAvailablePathForAttachment: async () => {
          throw new Error("unavailable");
        },
      } as unknown as FileManager,
      files,
      { mode: "obsidian-attachment-folder" },
      3,
    );

    expect(result).toEqual({
      fallback: "attachment-folder-unavailable",
      path: "notes/inkbook-20260102-030405-030303.svg",
    });
  });

  it("renames through FileManager and deletes recoverably through trashFile", async () => {
    const { state, vault } = createVault();
    const file = new FakeFile("drawings/old.svg");
    state.files.set(file.path, file);
    const renameFile = vi.fn(async (target: FakeFile, path: string) => {
      state.files.delete(target.path);
      target.path = path;
      state.files.set(path, target);
    });
    const trashFile = vi.fn(async () => undefined);
    const files = new ObsidianVaultFileAdapter(vault, classes, (path) => path);
    const managed = new ObsidianManagedFileAdapter(
      { renameFile, trashFile } as unknown as FileManager,
      files,
      (path) => path,
    );

    await managed.rename("drawings/old.svg", "drawings/new.svg");
    await managed.trash("drawings/new.svg");

    expect(renameFile).toHaveBeenCalledWith(file, "drawings/new.svg");
    expect(trashFile).toHaveBeenCalledWith(file);
  });
});
