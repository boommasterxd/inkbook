import { type Editor } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
  EmptyLineInsertionController,
  type CompletedEmptyLineInsertion,
  type EmptyLineInsertionNotifications,
} from "../../../../src/obsidian/commands";
import { guardedRead } from "../../../fixtures/obsidian/embed-paste";
import { ownedFileRead } from "../../../fixtures/obsidian/owned-file";

import { FakeEditor } from "./insertion-command-fixture";

function createHarness(editor: FakeEditor) {
  const insertions: CompletedEmptyLineInsertion[] = [];
  const failed = vi.fn();
  const notifications: EmptyLineInsertionNotifications = {
    failed,
    inserted: (insertion) => insertions.push(insertion),
  };
  const create = vi.fn(async (_path: string, content: string, _maximumBytes: number) => ({
    content,
  }));
  const trash = vi.fn(async (_path: string) => undefined);
  const controller = new EmptyLineInsertionController({
    documents: {
      prepare: async () => ({ content: "<svg />", path: "drawings/new.svg" }),
      verifyCreated: async () => true,
    },
    files: {
      createOwnedAndReadBack: async (path, content, maximumBytes, onCreated) => {
        const read = await create(path, content, maximumBytes);
        return ownedFileRead(path, guardedRead(path, read.content), onCreated);
      },
    },
    links: { generateEmbed: () => "![[../drawings/new.svg]]" },
    notifications,
    trash: { trash, trashCreated: (created) => trash(created.file.path) },
  });
  return {
    controller,
    create,
    editor: editor as unknown as Editor,
    failed,
    fakeEditor: editor,
    insertions,
    notifications,
    trash,
  };
}

interface FailedInsertionHarnessOptions {
  readonly editor?: FakeEditor;
  readonly prepare: () => Promise<{ readonly content: string; readonly path: string }>;
  readonly trashError?: Error;
  readonly verifyCreated: (content: string) => Promise<boolean>;
}

function createFailedInsertionHarness(options: FailedInsertionHarnessOptions) {
  const fakeEditor = options.editor ?? new FakeEditor([""]);
  const failed = vi.fn();
  const inserted = vi.fn();
  const trash = vi.fn(async (_path: string) => {
    if (options.trashError !== undefined) throw options.trashError;
  });
  const controller = new EmptyLineInsertionController({
    documents: { prepare: options.prepare, verifyCreated: options.verifyCreated },
    files: {
      createOwnedAndReadBack: async (path, content, _maximumBytes, onCreated) =>
        ownedFileRead(path, guardedRead(path, content), onCreated),
    },
    links: { generateEmbed: () => "![[new.svg]]" },
    notifications: { failed, inserted },
    trash: { trash, trashCreated: (created) => trash(created.file.path) },
  });
  return {
    controller,
    editor: fakeEditor as unknown as Editor,
    failed,
    fakeEditor,
    inserted,
    trash,
  };
}

async function insertIntoEmptyEditor(): Promise<ReturnType<typeof createHarness>> {
  const harness = createHarness(new FakeEditor([""]));
  harness.controller.request(harness.editor, "page.md");
  await vi.waitFor(() => expect(harness.insertions).toHaveLength(1));
  return harness;
}

describe("empty-line insertion", () => {
  it("creates the SVG before inserting a generated embed through Editor.replaceRange", async () => {
    const fake = new FakeEditor(["before", "", "after"], 1);
    const harness = createHarness(fake);

    expect(harness.controller.request(harness.editor, "notes/page.md")).toBe(true);
    expect(harness.controller.request(harness.editor, "notes/page.md")).toBe(false);
    await vi.waitFor(() => expect(harness.insertions).toHaveLength(1));

    expect(harness.create).toHaveBeenCalledWith("drawings/new.svg", "<svg />", expect.any(Number));
    expect(fake.lines).toEqual(["before", "", "", "![[../drawings/new.svg]]", "", "after"]);
    expect(harness.insertions[0]?.line).toBe(3);
    expect(harness.trash).not.toHaveBeenCalled();
  });

  it("trashes the created file and inserts no Markdown when worker verification fails", async () => {
    const harness = createFailedInsertionHarness({
      prepare: async () => ({ content: "<svg />", path: "new.svg" }),
      verifyCreated: async () => false,
    });

    expect(harness.controller.request(harness.editor, "page.md")).toBe(true);
    await vi.waitFor(() => expect(harness.failed).toHaveBeenCalledOnce());

    expect(harness.fakeEditor.lines[0]).toBe("");
    expect(harness.inserted).not.toHaveBeenCalled();
    expect(harness.trash).toHaveBeenCalledWith("new.svg");
  });
});

describe("empty-line insertion failure feedback", () => {
  it("preserves a user-modified embed when undo is stale", async () => {
    const harness = await insertIntoEmptyEditor();
    harness.fakeEditor.lines[2] = "changed";

    expect(await harness.insertions[0]?.undo()).toBe(false);
    expect(harness.editor.getLine(2)).toBe("changed");
    expect(harness.trash).not.toHaveBeenCalled();
    expect(harness.failed).toHaveBeenCalledWith("insertion-undo-note-changed", expect.any(Error));
  });
});
