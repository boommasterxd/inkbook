import { EditorState } from "@codemirror/state";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import type { createLivePreviewExtension } from "../../../src/obsidian/embeds/live-preview";
import type { InkbookDocumentRecognition } from "../../../src/obsidian/embeds/document-recognition";
import type { EmbedIntegrationPorts } from "../../../src/obsidian/embeds/presentation-port";
import { configureTestEditorState } from "../../adapters/obsidian/plugin";

export function livePreviewUpdatesFixture(
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
