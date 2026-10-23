import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { createLivePreviewExtension } from "../../../../../src/obsidian/embeds/live-preview/live-preview";
import type { EmbedIntegrationPorts } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import { configureTestEditorState } from "../../../../adapters/obsidian/plugin";
import { MARKDOWN_EMBED_LIMITS } from "../../../../../src/obsidian/embeds/markdown-embed";
import { expect, it, vi } from "vitest";

const capacity = MARKDOWN_EMBED_LIMITS.matches;
const sourcePath = "note.md";
const documentId = "handwriting.svg";

it("retains maximum-capacity pending decorations on unchanged host transactions with bounded work", () => {
  let resolutions = 0;
  let cacheReads = 0;
  const ports = {
    documents: {
      cached: () => {
        cacheReads += 1;
        return undefined;
      },
    },
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

  const flatten = vi.spyOn(state.doc, "toString");
  const lineReads = vi.spyOn(state.doc, "lineAt");
  const transaction = {};
  try {
    for (let sample = 0; sample < 2; sample += 1) {
      state = state.update(transaction).state;
    }
    expect(state.facet(EditorView.decorations)[0]).toBe(initial);
    expect(resolutions).toBe(capacity);
    expect(cacheReads).toBe(capacity);
    expect(flatten).not.toHaveBeenCalled();
    expect(lineReads).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});
