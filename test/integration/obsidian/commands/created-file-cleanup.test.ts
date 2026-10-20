import { TFile, TFolder, type Editor, type FileManager, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { EmptyLineInsertionController } from "../../../../src/obsidian/commands/empty-line-insertion";
import { EmbedPasteController } from "../../../../src/obsidian/commands/embed-paste";
import { ObsidianVaultFileAdapter } from "../../../../src/obsidian/vault/file-adapter";
import { ObsidianManagedFileAdapter } from "../../../../src/obsidian/vault/managed-files";
import { FakeEditor as PasteEditor } from "../../../fixtures/obsidian/embed-paste";
import { FakeEditor as InsertionEditor } from "./insertion-command-fixture";
import { createVaultEvents } from "../../../fixtures/obsidian/vault-events";

const TestTFile = TFile as unknown as new (path: string, size?: number) => TFile;
const PATH = "drawings/new.svg";
const CONTENT = "drawing";

type Failure =
  | "none"
  | "read"
  | "trash"
  | "create"
  | "collision"
  | "modified"
  | "replaced"
  | "same-stat-modify"
  | "modify-during-create"
  | "renamed";

function createVaultHarness(failure: Failure) {
  const entries = new Map<string, { file: TFile; content: string }>();
  const events = createVaultEvents();
  const source = new TestTFile("source.svg", CONTENT.length);
  entries.set(source.path, { file: source, content: CONTENT });
  const createError = new Error("create failed");
  const readError = new Error("read failed");
  const vault = {
    ...events,
    create: async (path: string, content: string) => {
      const file = new TestTFile(path, content.length);
      if (failure === "create") throw createError;
      entries.set(path, { file, content });
      if (failure === "collision") throw createError;
      if (failure === "modify-during-create") {
        entries.set(path, { file, content: "outside" });
        events.emit("modify", file);
      }
      return file;
    },
    getFileByPath: (path: string) => entries.get(path)?.file ?? null,
    read: async (file: TFile) => {
      if (file === source) return CONTENT;
      if (failure === "none") return CONTENT;
      if (failure === "modified") {
        entries.set(PATH, { file, content: "external change" });
        file.stat.mtime += 1;
      }
      if (failure === "replaced") {
        entries.set(PATH, { file: new TestTFile(PATH, CONTENT.length), content: "replacement" });
      }
      if (failure === "same-stat-modify") {
        entries.set(PATH, { file, content: "outside" });
        events.emit("modify", file);
      }
      if (failure === "renamed") {
        file.path = "drawings/renamed.svg";
        events.emit("rename", file, PATH);
        file.path = PATH;
        events.emit("rename", file, "drawings/renamed.svg");
      }
      throw readError;
    },
  } as unknown as Vault;
  const files = new ObsidianVaultFileAdapter(
    vault,
    { file: TFile, folder: TFolder },
    (path) => path,
  );
  const trashFile = vi.fn(async (file: TFile) => {
    if (failure === "trash") throw new Error("trash failed");
    if (entries.get(file.path)?.file === file) entries.delete(file.path);
  });
  const managedFiles = new ObsidianManagedFileAdapter(
    { trashFile } as unknown as FileManager,
    files,
    (path) => path,
  );
  return { entries, events, files, managedFiles, readError, trashFile };
}

function createCommandHarness(flow: "insertion" | "duplicate", failure: Failure) {
  const test = createVaultHarness(failure);
  const editor = flow === "insertion" ? new InsertionEditor([""]) : new PasteEditor();
  const hostEditor = editor as unknown as Editor;
  const failed = vi.fn();
  const inserted = vi.fn();
  const links = { generateEmbed: () => `!inkbook[[${PATH}]]` };
  const insertion = new EmptyLineInsertionController({
    documents: {
      prepare: async () => ({ content: CONTENT, path: PATH }),
      verifyCreated: async () => true,
    },
    files: test.files,
    links,
    notifications: { failed, inserted },
    trash: test.managedFiles,
  });
  const duplicate = new EmbedPasteController({
    choices: { choose: async () => "duplicate" },
    documents: test.files,
    links: { ...links, resolveLinkTarget: () => ({ path: "source.svg" }) },
    placement: { preparePath: async () => PATH },
    trash: test.managedFiles,
    validation: { validate: async () => true },
  });
  const run = async () => {
    if (flow === "insertion") {
      expect(insertion.request(hostEditor, "note.md")).toBe(true);
      await vi.waitFor(() => expect(failure === "none" ? inserted : failed).toHaveBeenCalledOnce());
      if (failure !== "none") expect(inserted).not.toHaveBeenCalled();
      expect(test.events.listenerCount()).toBe(0);
      return { kind: failure === "none" ? "inserted" : "failed" };
    }
    const outcome = await duplicate.paste({
      clipboardText: "!inkbook[[source.svg]]",
      editor: hostEditor,
      insideInkWidget: false,
      sourcePath: "note.md",
    });
    expect(test.events.listenerCount()).toBe(0);
    return outcome;
  };
  const noteContent = () =>
    editor instanceof InsertionEditor ? editor.lines.join("\n") : editor.content;
  return { ...test, noteContent, failed, run };
}

describe.each(["insertion", "duplicate"] as const)("%s creation rollback", (flow) => {
  it("releases temporary ownership listeners after successful insertion", async () => {
    const test = createCommandHarness(flow, "none");

    expect(await test.run()).toMatchObject({ kind: "inserted" });

    expect(test.entries.get(PATH)?.content).toBe(CONTENT);
    expect(test.noteContent()).toContain(`!inkbook[[${PATH}]]`);
    expect(test.trashFile).not.toHaveBeenCalled();
  });
  it("trashes its own unchanged SVG when creation succeeds but read-back rejects", async () => {
    const test = createCommandHarness(flow, "read");

    expect(await test.run()).toMatchObject({ kind: "failed" });

    expect(test.entries.has(PATH)).toBe(false);
    expect(test.entries.has("source.svg")).toBe(true);
    expect(test.trashFile).toHaveBeenCalledOnce();
    expect(test.noteContent()).toBe("");
  });

  it("reports failure and preserves the SVG when recoverable trash rejects", async () => {
    const test = createCommandHarness(flow, "trash");

    expect(await test.run()).toMatchObject({ kind: "failed" });

    expect(test.entries.get(PATH)?.content).toBe(CONTENT);
    expect(test.trashFile).toHaveBeenCalledOnce();
    expect(test.noteContent()).toBe("");
    if (flow === "insertion") {
      expect(test.failed).toHaveBeenCalledWith("insertion-cleanup-failed", expect.any(Error));
    }
  });

  it.each([
    ["create", undefined],
    ["collision", CONTENT],
    ["modified", "external change"],
    ["replaced", "replacement"],
    ["same-stat-modify", "outside"],
    ["modify-during-create", "outside"],
    ["renamed", CONTENT],
  ] as const)(
    "does not trash unowned or changed files after %s",
    async (failure, expectedContent) => {
      const test = createCommandHarness(flow, failure);

      expect(await test.run()).toMatchObject({ kind: "failed" });

      expect(test.trashFile).not.toHaveBeenCalled();
      expect(test.entries.get(PATH)?.content).toBe(expectedContent);
      expect(test.noteContent()).toBe("");
    },
  );
});

describe("unowned document creation", () => {
  it.each([
    "createAndReadBack",
    "createOwnedAndReadBack",
    "createAndReadBackForVerification",
  ] as const)(
    "preserves uncertain writes for %s callers without rollback ownership",
    async (method) => {
      const test = createVaultHarness("read");

      await expect(test.files[method](PATH, CONTENT, 100)).rejects.toBe(test.readError);

      expect(test.entries.get(PATH)?.content).toBe(CONTENT);
      expect(test.trashFile).not.toHaveBeenCalled();
    },
  );
});
