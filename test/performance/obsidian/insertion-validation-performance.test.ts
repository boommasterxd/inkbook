import { expect, it } from "vitest";

import { EmptyLineInsertionController } from "../../../src/obsidian/commands/empty-line-insertion";
import { registerInkbookCommands } from "../../../src/obsidian/commands/command-registry";
import type { Editor } from "obsidian";
import { guardedRead } from "../../fixtures/obsidian/embed-paste";
import { ownedFileRead } from "../../fixtures/obsidian/owned-file";

function longNote(lineCount: number) {
  let reads = 0;
  const editor = {
    getCursor: () => ({ ch: 0, line: lineCount }),
    getLine: (line: number) => {
      reads += 1;
      return line === lineCount ? "" : "Ordinary Markdown prose.";
    },
    lineCount: () => lineCount + 1,
  } as unknown as Editor;
  return {
    editor,
    reads: () => reads,
    reset: () => {
      reads = 0;
    },
  };
}

function insertionAttempt(implementation: {
  EmptyLineInsertionController: typeof EmptyLineInsertionController;
  registerInkbookCommands: typeof registerInkbookCommands;
}) {
  let finish = (): void => undefined;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const insertion = new implementation.EmptyLineInsertionController({
    documents: {
      prepare: async () => ({ content: "<svg />", path: "new.svg" }),
      // Stop at the external validation boundary to exercise the synchronous command-validation boundary.
      verifyCreated: async () => false,
    },
    files: {
      createOwnedAndReadBack: async (path, content, _maximumBytes, onCreated) =>
        ownedFileRead(path, guardedRead(path, content), onCreated),
    },
    links: { generateEmbed: () => "!inkbook[[new.svg]]" },
    notifications: { failed: finish, inserted: finish },
    trash: { trash: async () => undefined, trashCreated: async () => undefined },
  });
  const command = implementation.registerInkbookCommands(
    { addCommand: (registered) => registered },
    { execute: () => undefined, isAvailable: () => false },
    insertion,
  );
  return { command, settled };
}

it.for([10_000, 50_000])(
  "validates an insertion command once with bounded work after %i note lines",
  async (lineCount) => {
    const note = longNote(lineCount);
    for (let sample = 0; sample < 2; sample += 1) {
      const { command, settled } = insertionAttempt({
        EmptyLineInsertionController,
        registerInkbookCommands,
      });
      note.reset();

      const accepted = command.editorCheckCallback(false, note.editor, {
        file: { path: "note.md" },
      } as never);

      expect(accepted).toBe(true);
      expect(note.reads()).toBe(lineCount + 2);

      await settled;
    }
  },
);
