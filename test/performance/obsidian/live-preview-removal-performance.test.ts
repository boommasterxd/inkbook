import { EditorSelection, EditorState, StateEffect, type TransactionSpec } from "@codemirror/state";
import { expect, it } from "vitest";
import { removeLivePreviewMarkdown } from "../../../src/obsidian/embeds/live-preview-removal";
import { interactionP99, INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

const scrollAnchor = StateEffect.define<number>({ map: (value, changes) => changes.mapPos(value) });

it.for([10_000, 50_000])(
  "preserves the deletion scroll snapshot within one frame for %i Markdown lines",
  async (lineCount, { annotate }) => {
    const h = removalHarness(lineCount);
    const durations: number[] = [];
    for (let sample = -50; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
      h.reset();
      const started = performance.now();
      const removed = removeLivePreviewMarkdown(h.view, h.range, h.source, h.mutate);
      const elapsed = performance.now() - started;
      expect(removed).toBe(true);
      expect(h.snapshotReads()).toBe(1);
      expect(h.effectDispatches()).toBe(1);
      expect(h.anchor()).toBe(h.range.from);
      expect(h.view.state.doc.length).toBe(h.source.length - h.range.to + h.range.from);
      if (sample >= 0) durations.push(elapsed);
    }
    const p99 = interactionP99(durations);
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(
      `Deletion in ${String(lineCount)} Markdown lines p99=${p99.toFixed(3)} ms`,
      "performance",
    );
  },
);

function removalHarness(lineCount: number) {
  const prefix = "Before\n";
  const embed = "\n!inkbook[[drawing.svg]]\n\n";
  const source = prefix + embed + "Ordinary Markdown prose.\n".repeat(lineCount);
  const range = { from: prefix.length, to: prefix.length + embed.length };
  const initial = EditorState.create({
    doc: source,
    selection: EditorSelection.cursor(source.length),
  });
  let state = initial;
  let snapshots = 0;
  let dispatches = 0;
  let anchor = range.to;
  const view = {
    get state() {
      return state;
    },
    scrollSnapshot: () => {
      snapshots += 1;
      return scrollAnchor.of(anchor);
    },
    dispatch: (spec: TransactionSpec) => {
      dispatches += 1;
      const transaction = state.update(spec);
      state = transaction.state;
      for (const effect of transaction.effects) if (effect.is(scrollAnchor)) anchor = effect.value;
    },
  };
  return {
    source,
    range,
    view,
    snapshotReads: () => snapshots,
    effectDispatches: () => dispatches,
    anchor: () => anchor,
    mutate: () => {
      state = state.update({ changes: range }).state;
    },
    reset: () => {
      state = initial;
      snapshots = 0;
      dispatches = 0;
      anchor = range.to;
    },
  };
}
