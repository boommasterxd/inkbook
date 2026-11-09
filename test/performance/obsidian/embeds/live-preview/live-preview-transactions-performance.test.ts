import { EditorState, RangeSet, type RangeValue } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { createLivePreviewExtension } from "../../../../../src/obsidian/embeds/live-preview/live-preview";
import type { EmbedIntegrationPorts } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import { configureTestEditorState } from "../../../../adapters/obsidian/plugin";
import { MARKDOWN_EMBED_LIMITS } from "../../../../../src/obsidian/embeds/markdown-embed";
import { LivePreviewBlocks } from "../../../../../src/obsidian/embeds/live-preview/live-preview-blocks";
import { LivePreviewEntrances } from "../../../../../src/obsidian/embeds/live-preview/live-preview-entrances";
import { expect, it, vi } from "vitest";

const capacity = MARKDOWN_EMBED_LIMITS.matches;
const sourcePath = "note.md";
const documentId = "handwriting.svg";

it("retains maximum-capacity pending native candidates on unchanged host transactions with bounded work", () => {
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
    doc: Array.from({ length: capacity }, () => "![[handwriting.svg]]").join("\n\n"),
    extensions: [editorInfoField, editorLivePreviewField, createLivePreviewExtension(ports)],
  });
  const initial = state.facet(EditorView.decorations)[0];
  expect(initial).toMatchObject({ size: 0 });

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

for (const status of ["pending", "negative"] as const) {
  it(`queries only the visible range among maximum-capacity ${status} candidates before and after prose edits`, () => {
    const source = `Ordinary prose\n${Array.from(
      { length: capacity },
      (_, index) => `![[drawing-${index}.svg]]`,
    ).join("\n")}`;
    let state = EditorState.create({ doc: source });
    const cached = vi.fn(() => (status === "pending" ? undefined : (false as const)));
    const resolveDocument = vi.fn((id: string) => ({ documentId: id, resourceUrl: `app://${id}` }));
    const ports = { documents: { cached }, resolveDocument } as unknown as EmbedIntegrationPorts;
    const entrances = new LivePreviewEntrances(sourcePath);
    let blocks = LivePreviewBlocks.create(state, ports, entrances, {
      enabled: true,
      sourcePath,
    });
    expect(blocks.decorations.size).toBe(0);
    expect(resolveDocument).toHaveBeenCalledTimes(capacity);
    cached.mockClear();
    resolveDocument.mockClear();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The observer forwards the original RangeSet receiver with call().
    const originalBetween = RangeSet.prototype.between;
    let indexedVisits = 0;
    const queries = vi.spyOn(RangeSet.prototype, "between").mockImplementation(function (
      this: RangeSet<RangeValue>,
      from,
      to,
      visit,
    ) {
      originalBetween.call(this, from, to, (start, end, candidate) => {
        indexedVisits += 1;
        return visit(start, end, candidate);
      });
    });
    try {
      for (const edited of [false, true]) {
        if (edited) {
          const transaction = state.update({ changes: { from: 2, insert: "longer" } });
          const positions = vi.spyOn(transaction.changes, "mapPos");
          blocks = blocks.mapPlainTextEdit(transaction)!;
          // Native mapping moves unchanged index chunks rather than every candidate endpoint.
          expect(positions.mock.calls.length).toBeLessThan(capacity / 4);
          positions.mockRestore();
          state = transaction.state;
        }
        queries.mockClear();
        indexedVisits = 0;
        const line = state.doc.line(2049);
        const visit = vi.fn();
        blocks.visitVisible(
          [
            { from: line.from, to: line.to },
            { from: line.from + 1, to: line.to },
            { from: line.from, to: line.to },
          ],
          visit,
        );
        expect(queries).toHaveBeenCalled();
        expect(indexedVisits).toBe(1);
        expect(visit).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ from: line.from, to: line.to }),
        );
        expect(cached).not.toHaveBeenCalled();
        expect(resolveDocument).not.toHaveBeenCalled();
        expect(blocks.refresh(new Set(), ports, entrances)).toBe(blocks);
      }
    } finally {
      queries.mockRestore();
    }
  });
}
