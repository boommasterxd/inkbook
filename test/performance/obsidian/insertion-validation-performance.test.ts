import type { Editor } from "obsidian";
import { expect, it } from "vitest";

import { EmptyLineInsertionController } from "../../../src/obsidian/commands/empty-line-insertion";
import { registerInkbookCommands } from "../../../src/obsidian/commands/command-registry";
import { interactionP99, INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";

it.for([10_000, 50_000])(
  "validates an insertion command once within the frame budget after %i note lines",
  async (lineCount, { annotate }) => {
    const durations: number[] = [];
    const note = longNote(lineCount);
    for (let sample = -50; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
      const { command, settled } = insertionAttempt();
      note.reset();
      const started = performance.now();
      const accepted = command.editorCheckCallback(false, note.editor, {
        file: { path: "note.md" },
      } as never);
      const duration = performance.now() - started;
      expect(accepted).toBe(true);
      expect(note.reads()).toBe(lineCount + 2);
      if (sample >= 0) durations.push(duration);
      await settled;
    }
    const p99 = interactionP99(durations);
    expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
    await annotate(
      `Insertion after ${String(lineCount)} lines p99=${p99.toFixed(3)} ms`,
      "performance",
    );
  },
);

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

function insertionAttempt() {
  let finish = (): void => undefined;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const insertion = new EmptyLineInsertionController({
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
  const command = registerInkbookCommands(
    { addCommand: (registered) => registered },
    { execute: () => undefined, isAvailable: () => false },
    insertion,
  );
  return { command, settled };
}
