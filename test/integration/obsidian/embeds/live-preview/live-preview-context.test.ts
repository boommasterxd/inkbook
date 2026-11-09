import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { createLivePreviewExtension } from "../../../../../src/obsidian/embeds/live-preview/live-preview";
import { InkbookLivePreviewWidget } from "../../../../../src/obsidian/embeds/live-preview/live-preview-widget";
import type { EmbedIntegrationPorts } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import { configureTestEditorState } from "../../../../adapters/obsidian/plugin";

function createHarness(file: { path: string } | null, livePreview = true) {
  const recognize = vi.fn();
  const resolveDocument = vi.fn(() => ({
    documentId: "drawing.svg",
    resourceUrl: "app://drawing.svg",
  }));
  const ports = {
    documents: {
      cached: () => ({
        aspectRatio: 4,
        safeSvg: "<svg/>",
        contentIdentity: { revision: 1, outputHash: "a".repeat(64) },
      }),
      recognize,
    },
    resolveDocument,
  } as unknown as EmbedIntegrationPorts;
  configureTestEditorState({ file, livePreview });
  const state = EditorState.create({
    doc: "![[drawing.svg]]",
    extensions: [editorInfoField, editorLivePreviewField, createLivePreviewExtension(ports)],
  });
  const info = state.field(editorInfoField) as { file: { path: string } | null };
  return { info, recognize, resolveDocument, state };
}

function decorations(state: EditorState): DecorationSet {
  return state.facet(EditorView.decorations)[0] as DecorationSet;
}

function readyWidget(state: EditorState): InkbookLivePreviewWidget {
  let widget: unknown;
  decorations(state).between(0, state.doc.length, (_from, _to, decoration) => {
    widget = (decoration.spec as { widget: unknown }).widget;
  });
  expect(widget).toBeInstanceOf(InkbookLivePreviewWidget);
  return widget as InkbookLivePreviewWidget;
}

describe("Live Preview mutable host context", () => {
  it("replaces Markdown in the transaction that supplies the initially missing file", () => {
    const { info, recognize, resolveDocument, state } = createHarness(null);
    expect(decorations(state).size).toBe(0);
    info.file = { path: "note.md" };

    const ready = state.update({}).state;

    expect(readyWidget(ready)).toBeInstanceOf(InkbookLivePreviewWidget);
    expect(resolveDocument).toHaveBeenCalledWith("drawing.svg", "note.md");
    expect(recognize).not.toHaveBeenCalled();
    expect(decorations(state).size).toBe(0);
    expect(decorations(ready.update({}).state)).toBe(decorations(ready));
  });

  it("resolves a mutated file path again and replaces the other note's widget", () => {
    const file = { path: "first.md" };
    const { recognize, resolveDocument, state } = createHarness(file);
    const original = readyWidget(state);
    file.path = "second.md";

    const changed = state.update({}).state;

    expect(resolveDocument).toHaveBeenLastCalledWith("drawing.svg", "second.md");
    const fresh = readyWidget(changed);
    expect(fresh).not.toBe(original);
    expect(readyWidget(state)).toBe(original);
    expect(recognize).not.toHaveBeenCalled();
  });

  it("removes replacements when the host clears the file", () => {
    const { info, state } = createHarness({ path: "note.md" });
    info.file = null;
    expect(decorations(state.update({}).state).size).toBe(0);
  });

  it("preserves source mode after the host supplies a file", () => {
    const { info, resolveDocument, state } = createHarness(null, false);
    info.file = { path: "note.md" };
    expect(decorations(state.update({}).state).size).toBe(0);
    expect(resolveDocument).not.toHaveBeenCalled();
  });
});
