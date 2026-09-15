import { longNote, insertionAttempt } from "../../fixtures/obsidian/insertion-validation";
import { removalHarness } from "../../fixtures/obsidian/live-preview-removal";
import { assert } from "vitest";
import { ChangeSet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { livePreviewUpdatesFixture } from "../../fixtures/obsidian/live-preview-updates";
import type { ComparisonScenario } from "./contracts";
import { OBSIDIAN_EMBED_FEEDBACK_SCENARIOS } from "./obsidian-embed-feedback";
import { OBSIDIAN_EMBED_MOTION_SCENARIOS } from "./obsidian-embed-motion";

const directory = "test/performance/obsidian/";
const insertionScenarios: ComparisonScenario[] = [10_000, 50_000].map((lineCount) => ({
  id: `obsidian-insertion-${String(lineCount)}`,
  modules: ["obsidian/commands/empty-line-insertion", "obsidian/commands/command-registry"],
  covers: [
    {
      file: `${directory}insertion-validation-performance.test.ts`,
      test: `validates an insertion command once within the frame budget after ${String(lineCount)} note lines`,
      ordinals: [1],
    },
  ],
  statistics: [{ kind: "p99", population: "operations", minimumSamples: 100 }],
  execution: "async",

  warmupOperations: 20,
  create(implementation) {
    const { EmptyLineInsertionController } = implementation.get<
      typeof import("../../../src/obsidian/commands/empty-line-insertion")
    >("obsidian/commands/empty-line-insertion");
    const { registerInkbookCommands } = implementation.get<
      typeof import("../../../src/obsidian/commands/command-registry")
    >("obsidian/commands/command-registry");
    const note = longNote(lineCount);
    const constructors = { EmptyLineInsertionController, registerInkbookCommands };
    let attempt: ReturnType<typeof insertionAttempt>;
    let duration = 0;
    return {
      reset() {
        note.reset();
        attempt = insertionAttempt(constructors);
      },
      async run() {
        const started = performance.now();
        const result = attempt.command.editorCheckCallback(false, note.editor, {
          file: { path: "note.md" },
        } as never);
        duration = performance.now() - started;
        await attempt.settled;
        return result;
      },
      verify(result) {
        assert.strictEqual(result, true);
        assert.strictEqual(note.reads(), lineCount + 2);
      },
      measurementSamples: () => [duration],
      dispose() {},
    };
  },
}));

const removalScenarios: ComparisonScenario[] = [10_000, 50_000].map((lineCount) => ({
  id: `obsidian-removal-${String(lineCount)}`,
  modules: ["obsidian/embeds/live-preview-removal"],
  covers: [
    {
      file: `${directory}live-preview-removal-performance.test.ts`,
      test: `preserves the deletion scroll snapshot within one frame for ${String(lineCount)} Markdown lines`,
      ordinals: [1],
    },
  ],
  statistics: [{ kind: "p99", population: "operations", minimumSamples: 100 }],
  execution: "sync",

  warmupOperations: 20,
  create(implementation) {
    const { removeLivePreviewMarkdown } = implementation.get<
      typeof import("../../../src/obsidian/embeds/live-preview-removal")
    >("obsidian/embeds/live-preview-removal");
    const h = removalHarness(lineCount);
    return {
      reset: h.reset,
      run: () => removeLivePreviewMarkdown(h.view, h.range, h.source, h.mutate),
      verify(result) {
        assert.strictEqual(result, true);
        assert.strictEqual(h.snapshotReads(), 1);
        assert.strictEqual(h.effectDispatches(), 1);
        assert.strictEqual(h.anchor(), h.range.from);
        assert.strictEqual(h.view.state.doc.length, h.source.length - h.range.to + h.range.from);
      },
      dispose() {},
    };
  },
}));

const updateScenarios: ComparisonScenario[] = ["text edit", "recognition burst", "unchanged"].map(
  (operation) => ({
    id: `obsidian-live-preview-${operation.replaceAll(" ", "-")}`,
    modules: [
      "obsidian/embeds/live-preview",
      "obsidian/embeds/live-preview-recognition-effects",
      "obsidian/embeds/markdown-embed",
    ],
    covers: [
      {
        file: `${directory}live-preview-${operation === "unchanged" ? "entrances" : "updates"}-performance.test.ts`,
        test:
          operation === "unchanged"
            ? "retains maximum-capacity pending decorations on unchanged host transactions within the frame budget"
            : `updates maximum-capacity Live Preview for a ${operation} within the frame budget`,
        ordinals: [1],
      },
    ],
    statistics: [{ kind: "p99", population: "operations", minimumSamples: 100 }],
    execution: "sync",

    warmupOperations: 20,
    create(implementation) {
      const { createLivePreviewExtension } = implementation.get<
        typeof import("../../../src/obsidian/embeds/live-preview")
      >("obsidian/embeds/live-preview");
      const { documentRecognitionChanged } = implementation.get<
        typeof import("../../../src/obsidian/embeds/live-preview-recognition-effects")
      >("obsidian/embeds/live-preview-recognition-effects");
      const { MARKDOWN_EMBED_LIMITS } = implementation.get<
        typeof import("../../../src/obsidian/embeds/markdown-embed")
      >("obsidian/embeds/markdown-embed");
      const capacity = MARKDOWN_EMBED_LIMITS.matches;
      const { initial, ids, resolutions } = livePreviewUpdatesFixture(
        createLivePreviewExtension,
        capacity,
        operation,
      );
      let state = initial;
      return {
        reset() {
          state = initial;
        },
        run() {
          state = state.update(
            operation === "unchanged"
              ? {}
              : operation === "text edit"
                ? { changes: { from: 1, insert: "x" } }
                : { effects: documentRecognitionChanged.of(ids) },
          ).state;
        },
        verify() {
          assert.strictEqual(resolutions(), capacity);
          const actual = state.facet(EditorView.decorations)[0];
          const before = initial.facet(EditorView.decorations)[0];
          if (operation === "unchanged") assert.strictEqual(actual, before);
          else assert.notStrictEqual(actual, before);
        },
        dispose() {},
      };
    },
  }),
);

const entranceScenarios: ComparisonScenario[] = [false, true].map((remove) => ({
  id: `obsidian-retained-entrances-${remove ? "remove" : "map"}`,
  modules: ["obsidian/embeds/live-preview-entrances", "obsidian/embeds/markdown-embed"],
  covers: [
    {
      file: `${directory}live-preview-entrances-performance.test.ts`,
      test: remove
        ? "releases the full removed range within the frame budget and makes capacity reusable"
        : "maps a leading text insertion and retains ready and pending occurrences within the frame budget",
      ordinals: [1],
    },
  ],
  statistics: [{ kind: "p99", population: "operations", minimumSamples: 100 }],
  execution: "sync",

  warmupOperations: 20,
  create(implementation) {
    const { LivePreviewEntrances } = implementation.get<
      typeof import("../../../src/obsidian/embeds/live-preview-entrances")
    >("obsidian/embeds/live-preview-entrances");
    const { MARKDOWN_EMBED_LIMITS } = implementation.get<
      typeof import("../../../src/obsidian/embeds/markdown-embed")
    >("obsidian/embeds/markdown-embed");
    const capacity = MARKDOWN_EMBED_LIMITS.matches;
    const entrances = new LivePreviewEntrances("note.md");
    const tokens = Array.from({ length: capacity }, (_, index) => {
      const from = (index + 1) * 40;
      const token = entrances.stateFor(from, from + 30, "handwriting.svg");
      token.presented = index % 2 === 0;
      if (!token.presented) token.initialHeight = 48;
      return token;
    });
    const length = (capacity + 1) * 40;
    const changes = ChangeSet.of(
      remove ? { from: 0, to: length } : { from: 0, insert: "x" },
      length,
    );
    let mapped = entrances;
    let mismatches = 0;
    return {
      run() {
        mismatches = 0;
        mapped = entrances.update(changes, "note.md");
        if (!remove)
          for (let index = 0; index < capacity; index += 1) {
            const from = (index + 1) * 40 + 1;
            if (mapped.stateFor(from, from + 30, "handwriting.svg") !== tokens[index])
              mismatches += 1;
          }
      },
      verify() {
        assert.strictEqual(mismatches, 0);
        if (remove)
          for (let index = 0; index < capacity; index += 1) {
            const from = (index + 1) * 40;
            const fresh = mapped.stateFor(from, from + 30, "handwriting.svg");
            assert.notStrictEqual(fresh, tokens[index]);
            assert.strictEqual(fresh.presented, false);
            assert.strictEqual(mapped.stateFor(from, from + 30, "handwriting.svg"), fresh);
          }
      },
      dispose() {},
    };
  },
}));

export const OBSIDIAN_EMBED_SCENARIOS: readonly ComparisonScenario[] = [
  ...insertionScenarios,
  ...removalScenarios,
  ...updateScenarios,
  ...entranceScenarios,
  ...OBSIDIAN_EMBED_FEEDBACK_SCENARIOS,
  ...OBSIDIAN_EMBED_MOTION_SCENARIOS,
];
