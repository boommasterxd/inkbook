import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { createLivePreviewExtension } from "../../../src/obsidian/embeds/live-preview";
import type { EmbedIntegrationPorts } from "../../../src/obsidian/embeds/presentation-port";
import { configureTestEditorState } from "../../adapters/obsidian/plugin";
import { MARKDOWN_EMBED_LIMITS } from "../../../src/obsidian/embeds/markdown-embed";
import { expect, it } from "vitest";
import { expectTiming } from "../timing-assertions";
import { interactionP99, INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";

const capacity = MARKDOWN_EMBED_LIMITS.matches;
const sourcePath = "note.md";
const documentId = "handwriting.svg";

it("retains maximum-capacity pending decorations on unchanged host transactions within the frame budget", async ({
  annotate,
}) => {
  let resolutions = 0;
  const ports = {
    documents: { cached: () => undefined },
    resolveDocument: () => {
      resolutions += 1;
      return { documentId, resourceUrl: "app://handwriting.svg" };
    },
  } as unknown as EmbedIntegrationPorts;
  configureTestEditorState({ file: { path: sourcePath }, livePreview: true });
  let state = EditorState.create({
    doc: Array.from({ length: capacity }, () => "!inkbook[[handwriting.svg]]").join("\n\n"),
    extensions: [editorInfoField, editorLivePreviewField, createLivePreviewExtension(ports)],
  });
  const initial = state.facet(EditorView.decorations)[0];
  const durations = new Array<number>(INTERACTION_REFRESH_PROFILE.sampleCount);
  const transaction = {};
  for (let sample = -100; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
    const started = performance.now();
    state = state.update(transaction).state;
    if (sample >= 0) durations[sample] = performance.now() - started;
  }
  expect(state.facet(EditorView.decorations)[0]).toBe(initial);
  expect(resolutions).toBe(capacity);
  const p99 = interactionP99(durations);
  expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
  await annotate(
    `Unchanged context with ${String(capacity)} pending embeds p99=${p99.toFixed(3)} ms`,
    "performance",
  );
});
