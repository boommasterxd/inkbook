import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";

import { createLivePreviewExtension } from "../../../src/obsidian/embeds/live-preview";
import { documentRecognitionChanged } from "../../../src/obsidian/embeds/live-preview-recognition-effects";
import { MARKDOWN_EMBED_LIMITS } from "../../../src/obsidian/embeds/markdown-embed";
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
  let cacheReads = 0;
  let preview: InkbookDocumentRecognition | undefined;
  const ports = {
    documents: {
      cached: () => {
        cacheReads += 1;
        return preview;
      },
    },
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
  return { initial, ids, resolutions: () => resolutions, cacheReads: () => cacheReads };
}

function decorationWidgets(state: EditorState): readonly unknown[] {
  const decorations = state.facet(EditorView.decorations)[0];
  if (decorations === undefined || typeof decorations === "function")
    throw new Error("Missing static Live Preview decorations");
  const widgets: unknown[] = [];
  decorations.between(0, state.doc.length, (_from, _to, decoration) => {
    widgets.push((decoration.spec as { readonly widget: unknown }).widget);
  });
  return widgets;
}

for (const operation of ["text edit", "recognition burst"] as const) {
  it(`updates maximum-capacity Live Preview for a ${operation} with bounded work`, () => {
    const capacity = MARKDOWN_EMBED_LIMITS.matches;
    const { initial, ids, resolutions, cacheReads } = livePreviewUpdatesFixture(
      createLivePreviewExtension,
      capacity,
      operation,
    );

    const transaction =
      operation === "text edit"
        ? { changes: { from: 1, insert: "x" } }
        : { effects: documentRecognitionChanged.of(ids) };
    const initialWidgets = decorationWidgets(initial);
    const flatten = vi.spyOn(initial.doc, "toString");
    const lineReads = vi.spyOn(initial.doc, "lineAt");
    let state = initial;
    try {
      for (let sample = 0; sample < 2; sample += 1) {
        state = initial.update(transaction).state;
      }
      expect(flatten).not.toHaveBeenCalled();
      expect(lineReads).toHaveBeenCalledTimes(operation === "text edit" ? 2 : 0);
      const updatedWidgets = decorationWidgets(state);
      expect(updatedWidgets).toHaveLength(capacity);
      if (operation === "text edit") {
        for (let index = 0; index < capacity; index += 1)
          expect(updatedWidgets[index]).toBe(initialWidgets[index]);
      }
      expect(resolutions()).toBe(capacity);
      expect(cacheReads()).toBe(capacity * (operation === "recognition burst" ? 3 : 1));
      expect(state.facet(EditorView.decorations)[0]).not.toBe(
        initial.facet(EditorView.decorations)[0],
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
}
