import { removalHarness } from "../../fixtures/obsidian/live-preview-removal";
import { expect, it } from "vitest";
import { removeLivePreviewMarkdown } from "../../../src/obsidian/embeds/live-preview-removal";
import { interactionP99, INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

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
