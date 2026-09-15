import { EditorView } from "@codemirror/view";
import { expect, it } from "vitest";

import { createLivePreviewExtension } from "../../../src/obsidian/embeds/live-preview";
import { documentRecognitionChanged } from "../../../src/obsidian/embeds/live-preview-recognition-effects";
import { MARKDOWN_EMBED_LIMITS } from "../../../src/obsidian/embeds/markdown-embed";
import { livePreviewUpdatesFixture } from "../../fixtures/obsidian/live-preview-updates";
import { interactionP99, INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

for (const operation of ["text edit", "recognition burst"] as const) {
  it(`updates maximum-capacity Live Preview for a ${operation} within the frame budget`, async ({
    annotate,
  }) => {
    const capacity = MARKDOWN_EMBED_LIMITS.matches;
    const { initial, ids, resolutions } = livePreviewUpdatesFixture(
      createLivePreviewExtension,
      capacity,
      operation,
    );
    const durations: number[] = [];
    let state = initial;
    for (let sample = -100; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
      const started = performance.now();
      state = initial.update(
        operation === "text edit"
          ? { changes: { from: 1, insert: "x" } }
          : { effects: documentRecognitionChanged.of(ids) },
      ).state;
      if (sample >= 0) durations.push(performance.now() - started);
    }
    expect(resolutions()).toBe(capacity);
    expect(state.facet(EditorView.decorations)[0]).not.toBe(
      initial.facet(EditorView.decorations)[0],
    );
    const p99 = interactionP99(durations);
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(
      `${operation} with ${String(capacity)} embeds p99=${p99.toFixed(3)} ms`,
      "performance",
    );
  });
}
