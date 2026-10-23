import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { createLivePreviewExtension } from "../../../../../src/obsidian/embeds/live-preview/live-preview";
import { InkbookLoadingPreviewWidget } from "../../../../../src/obsidian/embeds/live-preview/live-preview-loading-widget";
import type { EmbedIntegrationPorts } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import { configureTestEditorState } from "../../../../adapters/obsidian/plugin";

function createHarness(file: { path: string } | null, livePreview = true) {
  const recognize = vi.fn();
  const resolveDocument = vi.fn(() => ({
    documentId: "drawing.svg",
    resourceUrl: "app://drawing.svg",
  }));
  const ports = {
    documents: { cached: () => undefined, recognize },
    resolveDocument,
  } as unknown as EmbedIntegrationPorts;
  configureTestEditorState({ file, livePreview });
  const state = EditorState.create({
    doc: "!inkbook[[drawing.svg]]",
    extensions: [editorInfoField, editorLivePreviewField, createLivePreviewExtension(ports)],
  });
  const info = state.field(editorInfoField) as { file: { path: string } | null };
  return { info, recognize, resolveDocument, state };
}

function decorations(state: EditorState): DecorationSet {
  return state.facet(EditorView.decorations)[0] as DecorationSet;
}

function pendingWidget(state: EditorState): InkbookLoadingPreviewWidget {
  let widget: unknown;
  decorations(state).between(0, state.doc.length, (_from, _to, decoration) => {
    widget = (decoration.spec as { widget: unknown }).widget;
  });
  expect(widget).toBeInstanceOf(InkbookLoadingPreviewWidget);
  return widget as InkbookLoadingPreviewWidget;
}

describe("Live Preview mutable host context", () => {
  it("replaces Markdown in the transaction that supplies the initially missing file", () => {
    const { info, recognize, resolveDocument, state } = createHarness(null);
    expect(decorations(state).size).toBe(0);
    info.file = { path: "note.md" };

    const ready = state.update({}).state;

    expect(pendingWidget(ready).entranceState.presented).toBe(false);
    expect(resolveDocument).toHaveBeenCalledWith("drawing.svg", "note.md");
    expect(recognize).not.toHaveBeenCalled();
    expect(decorations(state).size).toBe(0);
    expect(decorations(ready.update({}).state)).toBe(decorations(ready));
  });

  it("resolves a mutated file path again and resets the other note's entrance", () => {
    const file = { path: "first.md" };
    const { recognize, resolveDocument, state } = createHarness(file);
    const original = pendingWidget(state).entranceState;
    original.presented = true;
    original.initialHeight = 72;
    file.path = "second.md";

    const changed = state.update({}).state;

    expect(resolveDocument).toHaveBeenLastCalledWith("drawing.svg", "second.md");
    const fresh = pendingWidget(changed).entranceState;
    expect(fresh).not.toBe(original);
    expect(fresh.presented).toBe(false);
    expect(fresh.initialHeight).toBeUndefined();
    expect(pendingWidget(state).entranceState).toBe(original);
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
