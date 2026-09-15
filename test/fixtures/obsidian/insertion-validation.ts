import type { Editor } from "obsidian";
import type { EmptyLineInsertionController } from "../../../src/obsidian/commands/empty-line-insertion";
import type { registerInkbookCommands } from "../../../src/obsidian/commands/command-registry";

export function longNote(lineCount: number) {
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

export function insertionAttempt(implementation: {
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
      // Stop at the external validation boundary so the timed target stays unchanged.
      verifyCreated: async () => false,
    },
    files: { createAndReadBack: async (_path, content) => ({ content }) },
    links: { generateEmbed: () => "!inkbook[[new.svg]]" },
    notifications: { failed: finish, inserted: finish },
    trash: { trash: async () => undefined },
  });
  const command = implementation.registerInkbookCommands(
    { addCommand: (registered) => registered },
    { execute: () => undefined, isAvailable: () => false },
    insertion,
  );
  return { command, settled };
}
