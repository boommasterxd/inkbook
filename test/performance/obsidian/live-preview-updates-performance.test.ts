import { EditorView } from "@codemirror/view";
import { expect, it } from "vitest";

import { createLivePreviewExtension } from "../../../src/obsidian/embeds/live-preview";
import { documentRecognitionChanged } from "../../../src/obsidian/embeds/live-preview-recognition-effects";
import { MARKDOWN_EMBED_LIMITS } from "../../../src/obsidian/embeds/markdown-embed";
import { interactionP99, INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";
import { EditorState } from "@codemirror/state";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import type { InkbookDocumentRecognition } from "../../../src/obsidian/embeds/document-recognition";
import type { EmbedIntegrationPorts } from "../../../src/obsidian/embeds/presentation-port";
import { configureTestEditorState } from "../../adapters/obsidian/plugin";

function livePreviewUpdatesFixture(
  extension: typeof createLivePreviewExtension,
  capacity: number,
  operation: string,
) {
  const ids = Array.from({ length: capacity }, (_, index) =>
    operation === "unchanged" ? "handwriting.svg" : `drawing-${String(index)}.svg`,
  );
  let resolutions = 0;
  let preview: InkbookDocumentRecognition | undefined;
  const ports = {
    documents: { cached: () => preview },
    resolveDocument: (documentId: string) => {
      resolutions += 1;
      return { documentId, resourceUrl: `app://${documentId}` };
    },
  } as unknown as EmbedIntegrationPorts;
  configureTestEditorState({ file: { path: "note.md" }, livePreview: true });
  const doc =
    operation === "unchanged"
      ? ids.map((id) => `!inkbook[[${id}]]`).join("\n\n")
      : `Ordinary prose\n\n${ids.map((id) => `!inkbook[[${id}]]\n\n${"Ordinary prose ".repeat(16)}`).join("\n\n")}`;
  const initial = EditorState.create({
    doc,
    extensions: [editorInfoField, editorLivePreviewField, extension(ports)],
  });
  if (operation === "recognition burst")
    preview = {
      aspectRatio: 1,
      safeSvg: "<svg/>",
      contentIdentity: { revision: 1, outputHash: "a".repeat(64) },
    };
  return { initial, ids, resolutions: () => resolutions };
}

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
