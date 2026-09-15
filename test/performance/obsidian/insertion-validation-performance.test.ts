import { longNote, insertionAttempt } from "../../fixtures/obsidian/insertion-validation";
import { expect, it } from "vitest";

import { EmptyLineInsertionController } from "../../../src/obsidian/commands/empty-line-insertion";
import { registerInkbookCommands } from "../../../src/obsidian/commands/command-registry";
import { interactionP99, INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

it.for([10_000, 50_000])(
  "validates an insertion command once within the frame budget after %i note lines",
  async (lineCount, { annotate }) => {
    const durations: number[] = [];
    const note = longNote(lineCount);
    for (let sample = -50; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
      const { command, settled } = insertionAttempt({
        EmptyLineInsertionController,
        registerInkbookCommands,
      });
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
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(
      `Insertion after ${String(lineCount)} lines p99=${p99.toFixed(3)} ms`,
      "performance",
    );
  },
);
